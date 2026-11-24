/** One error type for the shell: a stable code plus a message that never carries a secret. */
export class ShellError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ShellError';
    this.code = code;
    this.details = details;
  }
}

export const fail = (code, message, details) => {
  throw new ShellError(code, message, details);
};
