const path = require('path');


module.exports = {
  mode: 'none',
  entry: {
	  background:	'./background.js',
	  brief:	'./ui/brief',
  },
  output: {
    path: path.resolve(__dirname, './minimized/'),
    filename: 'minni-[name].js',
  },
};
