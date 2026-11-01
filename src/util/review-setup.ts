export class ReviewSetupError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "ReviewSetupError";
  }
}
