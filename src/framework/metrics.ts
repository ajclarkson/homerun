export interface MetricsBackend {
  incrementCounter(name: string, labels?: Record<string, string>): void;
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
}

export class NoopMetricsBackend implements MetricsBackend {
  incrementCounter(): void {}
  observeHistogram(): void {}
}
