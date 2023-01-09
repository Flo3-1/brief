const path = require('path');

/*module.exports = {
  mode: 'none',
  entry: './node_modules/dom-parser/index.js',
  output: {
    path: path.resolve(__dirname, 'modules'),
    filename: 'DOMpars.js',
  },
};*/

module.exports = {
  mode: 'none',
  entry: './background.js',
  output: {
    path: path.resolve(__dirname, '.'),
    filename: 'minni-background.js',
  },
};

module.exports = {
  mode: 'none',
  entry: './ui/brief.js',
  output: {
    path: path.resolve(__dirname, 'ui'),
    filename: 'minni-brief.js',
  },
};
