import { Channels } from 'main/preload';
import { Fob } from '../main/db';

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        sendMessage(channel: Channels, args: unknown[]): void;
        on(channel: 'fobs', func: (fobs: Fob[]) => void): void;
        on(channel: 'fob', func: (fob: Fob) => void): void;
        on(channel: 'card', func: (fobNumber: string) => void): void;
        on(channel: 'card2', func: (id: number, count: number) => void): void;
        on(
          channel: string,
          func: (...args: unknown[]) => void
        ): (() => void) | undefined;
        once(
          channel: 'login',
          func: (res: { success: boolean; message: string }) => void
        ): void;
        once(channel: 'start', func: (arg: boolean) => void): void;
        once(channel: 'start2', func: (arg: boolean) => void): void;
        once(channel: string, func: (...args: unknown[]) => void): void;
      };
    };
  }
}

export {};
