// Standalone Node tests: transpile only requested files, never load Next or .env.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
function createSourceLoader(overrides = {}) {
const loaded = new Map();
function loadSource(file) {
  const filename = path.resolve(__dirname, '..', file);
  if (path.basename(filename) === 'db.ts') throw new Error('Tests must mock the application database module');
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const errors = result.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
  const instance = new Module(filename, module);
  loaded.set(filename, instance);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  instance.require = request => {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) return overrides[request];
    if (request === './db' || request === '@/lib/db') throw new Error('Tests must mock the application database module');
    if (request.startsWith('@/lib/')) return loadSource(request.slice('@/lib/'.length) + '.ts');
    if (request.startsWith('.')) {
      const target = path.resolve(path.dirname(filename), request + '.ts');
      if (fs.existsSync(target)) return loadSource(target);
    }
    return require(request);
  };
  instance._compile(result.outputText, filename);
  return instance.exports;
}
return loadSource;
}

module.exports = { loadSource: createSourceLoader(), createSourceLoader };
