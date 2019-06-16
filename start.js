// import environmental variables from our variables.env file
require('dotenv').config({ path: 'variables.env' });

// Start our app!
const app = require('./app');

app.set('port', process.env.PORT || 8765);

const server = app.listen(app.get('port'), () => {
  console.log(`Express running → PORT ${server.address().port}`);
});