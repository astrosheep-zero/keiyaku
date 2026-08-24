export type RunLogReference = Readonly<{
  path: string;
  from: number;
  to: number;
}>;

export type DetachedProcessExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  log: RunLogReference;
}>;

export type OwnedProcess = Readonly<{
  pid: number;
  exited: Promise<DetachedProcessExit>;
  terminate(force?: boolean): Promise<void>;
  release(): void;
}>;
