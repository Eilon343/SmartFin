// Only so Jest can require the frontend's pure helper modules, which are written as ESM
// because Vite consumes them. Backend and bot sources are CommonJS and pass through
// unchanged. Targeting the running Node keeps the transform to module syntax alone.
module.exports = {
    presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
    ],
};
