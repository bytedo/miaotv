const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const jsxRuntime = require('react/jsx-runtime');
const withoutStyledJsxFlags = render => (type, props, ...args) => {
  // Next compiles these flags; this isolated renderer only needs the style text.
  if (type === 'style' && props?.jsx) {
    const { jsx: _jsx, global: _global, ...styleProps } = props;
    return render(type, styleProps, ...args);
  }
  return render(type, props, ...args);
};

// Render individual components without importing Next, environment files or a database.
function createComponentLoader(overrides = {}) {
  const loadSource = createSourceLoader(overrides);
  return function loadComponent(file) {
    const filename = path.resolve(__dirname, '../..', file);
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    const errors = result.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
    const instance = new Module(filename, module);
    instance.filename = filename;
    instance.paths = Module._nodeModulePaths(path.dirname(filename));
    instance.require = request => {
      if (Object.prototype.hasOwnProperty.call(overrides, request)) return overrides[request];
      if (request === 'react/jsx-runtime') return {
        ...jsxRuntime,
        jsx: withoutStyledJsxFlags(jsxRuntime.jsx),
        jsxs: withoutStyledJsxFlags(jsxRuntime.jsxs),
      };
      if (request.startsWith('@/hooks/')) return loadSource('../hooks/' + request.slice('@/hooks/'.length) + '.ts');
      if (request.startsWith('@/lib/')) return loadSource(request.slice('@/lib/'.length) + '.ts');
      return require(request);
    };
    instance._compile(result.outputText, filename);
    return instance.exports;
  };
}

module.exports = { createComponentLoader };
