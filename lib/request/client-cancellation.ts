/** Internal transport marker: upstream timeouts may also use AbortError. */
export class ClientCancellationError extends Error {
    constructor() {
        super("Client cancelled request");
        this.name = "AbortError";
    }
}
