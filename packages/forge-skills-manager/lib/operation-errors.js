class PendingOperationError extends Error {
  code = "error.repo.installState";
  statusCode = 500;
  inspect;
  constructor(message, inspect) {
    super(message);
    this.inspect = inspect;
  }
}
function operationRejection(result) {
  return {
    code: "code" in result && typeof result.code === "string" && /^error\.[a-zA-Z0-9.]+$/.test(result.code) ? result.code : "error.proto.rejected",
    error: "error" in result && typeof result.error === "string" && result.error.trim() ? result.error : "\u64CD\u4F5C\u5DF2\u62D2\u7EDD"
  };
}
function isExpectedOperationError(error) {
  if (error instanceof ReferenceError || error instanceof TypeError) return false;
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return false;
  return /^error\.[a-zA-Z0-9.]+$/.test(error.code) || /^E[A-Z0-9]+$/.test(error.code);
}
export {
  PendingOperationError,
  isExpectedOperationError,
  operationRejection
};
