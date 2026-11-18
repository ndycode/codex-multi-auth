import { withFileTransactionLock } from "../storage/file-lock.js";
/** Shared across CLI processes: protect the native provider check and desktop auth write. */
export function withNativeBindingLock<T>(configPath: string, action: () => Promise<T>): Promise<T> {
    return withFileTransactionLock(`${configPath}.native-bind`, action);
}
