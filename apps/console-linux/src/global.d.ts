export {};

declare global {
  interface Window {
    mbfdConsoleShell?: {
      onStatus: (callback: (status: string) => void) => () => void;
    };
  }
}
