// Express 4 has no idea what a promise is. When an `async` handler rejects,
// the rejection is never handed to next(), so it escapes the request entirely
// and becomes an unhandled promise rejection — which Node 24 treats as fatal
// and uses to kill the process. The socket dies with the process, which is why
// the client sees "read ECONNRESET" instead of a response.
//
// Wrapping a handler funnels any rejection back into the normal Express error
// pipeline, where the error-handling middleware in index.js can log it and
// answer with JSON.
export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default asyncHandler;
