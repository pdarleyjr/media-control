const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');

function createTrustedUploadStorage({ root, createFilename }) {
  const configuredRoot = path.resolve(root);
  const issuedPaths = new WeakMap();
  const fileCapability = Symbol('trusted-upload-capability');

  fs.mkdirSync(configuredRoot, { recursive: true });
  const rootRealPath = fs.realpathSync(configuredRoot);

  const storage = multer.diskStorage({
    destination: (req, file, callback) => callback(null, rootRealPath),
    filename: (req, file, callback) => {
      try {
        const filename = createFilename(file);
        if (!filename || filename !== path.basename(filename)) {
          return callback(new Error('Upload filename must be a direct child name'));
        }
        const candidate = path.join(rootRealPath, filename);
        const capability = Object.freeze({});
        issuedPaths.set(capability, { filename, candidate });
        Object.defineProperty(file, fileCapability, {
          configurable: false,
          enumerable: true,
          value: capability,
          writable: false,
        });
        return callback(null, filename);
      } catch (error) {
        return callback(error);
      }
    },
  });

  function resolveUploadedFilePath(file) {
    const issued = file && issuedPaths.get(file[fileCapability]);
    if (!issued || file.filename !== issued.filename) return null;
    try {
      const stat = fs.lstatSync(issued.candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      const realPath = fs.realpathSync(issued.candidate);
      return path.dirname(realPath) === rootRealPath ? realPath : null;
    } catch {
      return null;
    }
  }

  function discardUploadedFile(file) {
    const uploadedPath = resolveUploadedFilePath(file);
    if (!uploadedPath) return false;
    try {
      fs.unlinkSync(uploadedPath);
      return true;
    } catch {
      return false;
    }
  }

  function uploadedFileHasBytes(file) {
    if (!Number.isFinite(Number(file?.size)) || Number(file.size) <= 0) return false;
    const uploadedPath = resolveUploadedFilePath(file);
    if (!uploadedPath) return false;
    try {
      const stat = fs.lstatSync(uploadedPath);
      return !stat.isSymbolicLink() && stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  return { storage, resolveUploadedFilePath, discardUploadedFile, uploadedFileHasBytes };
}

module.exports = { createTrustedUploadStorage };
