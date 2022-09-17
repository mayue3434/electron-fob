import { WebContents, ipcMain, IpcMainEvent, dialog } from 'electron';
import { NFC, Reader } from 'nfc-pcsc';
import EventEmitter from 'events';

import Encryption from './Encryption';
import { alert, delay } from './util';
import { Fob } from './db';
import ResponseError from './ResponseError';

export default class NfcController extends EventEmitter {
  private webContents: WebContents;

  private nfc: NFC = null;

  private reader: Reader = null;

  private running = false;

  constructor(webContents: WebContents) {
    super();
    this.webContents = webContents;
    ipcMain.on('start', this.start);
    ipcMain.on('stop', this.stop);
  }

  start = (event: IpcMainEvent, args: [string]) => {
    const [fobNumber] = args;
    if (fobNumber !== '') {
      alert('error', 'Please remove the fob from the reader, then start.');
      event.reply('start', 0);
      return;
    }
    if (!this.reader) {
      alert('error', 'No NFC reader is found');
      event.reply('start', 0);
      return;
    }
    this.running = true;
    event.reply('start', 1);
  };

  stop = () => {
    this.running = false;
  };

  initNfc = () => {
    this.nfc = new NFC();

    this.nfc.on('reader', async (reader: Reader) => {
      this.reader = reader;
      console.log(`device attached`, reader.reader.name);
      reader.autoProcessing = false;

      reader.on('card', async (card) => {
        const fobNumber = card.atr
          .slice(-5, -1)
          .reduce((prev: string, num: number) => num.toString(16) + prev, '');
        console.log(`card detected: ${fobNumber}`);
        this.webContents.send('card', fobNumber);

        if (!this.running) return;
        this.webContents.send('initializing', true);

        try {
          let fob = await Fob.findOne({ where: { fobNumber } });
          if (fob?.uploaded) {
            alert('error', 'The fob has been uploaded');
            return;
          }
          if (fob?.initialized) {
            alert('error', 'The fob has been initialized');
            return;
          }

          if (!fob) fob = await Fob.create({ fobNumber });

          await this.selectFob(fob);
          await delay(150); // TODO find reset function if possible

          const secret = fob.secret && !fob.initialized ? fob.secret : null;
          let res = await this.doExternalAuthentication(fob, secret); // TODO test to check all error
          if (res.slice(0, 3) === '63c') {
            alert(
              'error',
              `External authentication error: res = ${res === '' ? '""' : res}`
            );
          } else if (res === '6a88') {
            // 6a88: key not found
            res = await this.createFile(fob);
            // 6a86: the param P1 or P2 is wrong (the file has been created)
            if (res !== '6a86' && res !== '9000') {
              alert(
                'error',
                `Create file error: res = ${res === '' ? '""' : res}`
              );
              return;
            }
            await this.addSecret(fob);
            // TODO upload
          } else if (res !== '9000') {
            alert(
              'error',
              `External authentication error: res = ${res === '' ? '""' : res}`
            );
          } else {
            res = await this.cleanData(fob);
            res = await this.createFile(fob);
            if (res !== '9000') {
              alert(
                'error',
                `Create file error: res = ${res === '' ? '""' : res}`
              );
              return;
            }
            await this.addSecret(fob);
            // TODO upload
          }
        } catch (err) {
          if (err instanceof ResponseError) {
            alert(
              'error',
              `${err.message}: res = ${err.res === '' ? '""' : err.res}`
            );
            return;
          }
          alert('error', JSON.stringify(err));
        } finally {
          this.webContents.send('initializing', false);
        }
      });

      reader.on('card.off', (card) => {
        console.log(
          `card removed:`,
          card.atr
            .slice(-5, -1)
            .reduce((prev: string, num: number) => num.toString(16) + prev, '')
        );
        this.webContents.send('card', '');
      });

      reader.on('error', (err: Error) => {
        console.log(`reader: an error occurred`, reader.reader.name, err);
      });

      reader.on('end', () => {
        console.log(`device removed`, reader.reader.name);
        this.reader.removeAllListeners();
        this.reader = null;
        if (this.running) alert('error', 'NFC reader is unplugged!');
        this.running = false;
        this.webContents.send('interrupt');
      });
    });

    this.nfc.on('error', (err: Error) => {
      console.log(`nfc: an error occurred`, err);
    });
  };

  selectFob = async (fob: Fob) => {
    return this.transmit(fob, 'Select MF', '00A40000023F00');
  };

  doExternalAuthentication = async (fob: Fob, secret: string | null) => {
    const encryption = new Encryption(secret || 'FFFFFFFFFFFFFFFF');
    let times = 2;
    let res: string;
    do {
      // eslint-disable-next-line no-await-in-loop
      res = await this.transmit(
        fob,
        'Get random numbers',
        '008400000400000000'
      );
      const randomStr = res.slice(0, 8);
      const encrypted = encryption.encrypt(`${randomStr}00000000`);
      // eslint-disable-next-line no-await-in-loop
      res = await this.transmit(
        fob,
        'External Authentication',
        `0082000008${encrypted}`
      );
      times -= 1;
    } while (times > 0 && res === '6984');
    return res;
  };

  cleanData = async (fob: Fob) => {
    return this.transmit(fob, 'Clean data', '800E000000');
  };

  createFile = async (fob: Fob) => {
    return this.transmit(fob, 'Create file', '80E00000073F005001F1FFFF');
  };

  addSecret = async (fob: Fob) => {
    const secret = 'FFFFFFFFFFFFFFFF'; // TODO update to random 3DES key
    await fob.update({ secret });
    await this.transmit(fob, 'Add secret', `80D401000D39F0F1AAFF${secret}`);
    await fob.update({ initialized: true });
  };

  transmit = async (fob: Fob, state: string, req: string) => {
    const reqBuffer = Buffer.from(req, 'hex');
    await this.display(fob, state, 'req', req);
    const res: string = (await this.reader.transmit(reqBuffer, 50)).toString(
      'hex'
    );
    await this.display(fob, state, 'res', res);
    if (state === 'External Authentication' || state === 'Create file')
      return res; // check the res in main func
    if (res === '') throw new ResponseError(`${state} error`, '""');
    if (res.slice(-4) !== '9000')
      throw new ResponseError(`${state} error`, res);
    return res;
  };

  display = async (
    fob: Fob,
    state: string,
    direction: 'req' | 'res',
    cmd: string
  ) => {
    if (direction === 'req') {
      console.log(`-- ${state} --`);
    }
    console.log(direction, cmd);
    if (direction === 'req') {
      await fob.update({ state: `${state}...` });
    } else {
      await fob.update({ state: `${state} - ${cmd.slice(-4) || '""'}` });
    }
    this.webContents.send('fob', fob.toJSON(), direction);
  };
}
