export class ValhallaRoutingError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ValhallaRoutingError";
  }
}
