const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch'); // npm i node-fetch@2
const { twiml: { VoiceResponse } } = require('twilio');
const products = require('./products.json'); // Your catalog
const app = express();

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// In-memory session store (simple for demo)
const sessions = {};

function getSession(callSid) {
  if (!sessions[callSid]) {
    sessions[callSid] = { cart: [], step: 0 };
  }
  return sessions[callSid];
}

// Search products helper (reuse your logic)
function searchParts(year, make, model, part) {
  const qYear = (year || '').toString();
  const qMake = (make || '').toLowerCase();
  const qModel = (model || '').toLowerCase();
  const qPart = (part || '').toLowerCase();

  return products.filter(p => {
    const fits = p.fits || [];
    const fitMatch = fits.some(f => {
      const yearMatch = !qYear || f.year.toString() === qYear;
      const makeMatch = !qMake || f.make.toLowerCase() === qMake;
      const modelMatch = !qModel || f.model.toLowerCase() === qModel;
      return yearMatch && makeMatch && modelMatch;
    });
    const partMatch = !qPart || p.title.toLowerCase().includes(qPart) || p.partType.toLowerCase().includes(qPart);
    return fitMatch && partMatch;
  });
}

// Step 1: Welcome and gather Year/Make/Model/Part
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  const response = new VoiceResponse();

  const gather = response.gather({
    input: 'speech',
    action: '/process-speech',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'Toyota, Honda, Ford, Camry, Accord, Brake Pads, Oil Filter',
  });

  gather.say('Welcome to Auto Parts Finder. Please say the year, make, model, and part you want to search for.');
  res.type('text/xml').send(response.toString());
});

// Step 2: Process speech, parse inputs, search products, and read results
app.post('/process-speech', (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const session = getSession(callSid);
  const response = new VoiceResponse();

  // Parse info (basic regex, improve for production)
  const yearMatch = speechResult.match(/(\d{4})/);
  const makeMatch = speechResult.match(/(Toyota|Honda|Ford|Nissan|Chevrolet)/i);
  const modelMatch = speechResult.match(/(Camry|Accord|Civic|Focus|Corolla)/i);
  const partMatch = speechResult.match(/(brake pads?|oil filter|engine|transmission)/i);

  if (!(yearMatch && makeMatch && modelMatch && partMatch)) {
    response.say('Sorry, I did not understand. Please say the year, make, model, and part again.');
    response.redirect('/voice');
    return res.type('text/xml').send(response.toString());
  }

  // Save search params in session
  session.searchParams = {
    year: yearMatch[1],
    make: makeMatch[1],
    model: modelMatch[1],
    part: partMatch[1],
  };

  // Search products
  const found = searchParts(session.searchParams.year, session.searchParams.make, session.searchParams.model, session.searchParams.part);
  session.searchResults = found.slice(0, 5); // Limit to 5 results for demo
  session.step = 2;

  if (session.searchResults.length === 0) {
    response.say(`No parts found for your ${session.searchParams.year} ${session.searchParams.make} ${session.searchParams.model} ${session.searchParams.part}.`);
    response.say('Please try again.');
    response.redirect('/voice');
    return res.type('text/xml').send(response.toString());
  }

  response.say(`I found ${session.searchResults.length} parts for your ${session.searchParams.year} ${session.searchParams.make} ${session.searchParams.model} ${session.searchParams.part}.`);
  session.searchResults.forEach((p, i) => {
    response.say(`Press ${i + 1} to add ${p.title} priced at ${p.price} dollars to your cart.`);
  });
  response.say('Press 9 to hear your cart and get a quote.');
  response.say('Press 0 to end the call.');

  // Gather digits for choice
  const gather = response.gather({
    numDigits: 1,
    action: '/handle-choice',
    method: 'POST',
    timeout: 10
  });
  res.type('text/xml').send(response.toString());
});

// Step 3: Handle digit input for adding items, quoting, or ending
app.post('/handle-choice', (req, res) => {
  const callSid = req.body.CallSid;
  const digit = req.body.Digits;
  const session = getSession(callSid);
  const response = new VoiceResponse();

  if (!session.searchResults) {
    response.say('Session expired. Starting over.');
    response.redirect('/voice');
    return res.type('text/xml').send(response.toString());
  }

  if (digit === '0') {
    response.say('Thank you for calling Auto Parts Finder. Goodbye!');
    response.hangup();
    delete sessions[callSid];
    return res.type('text/xml').send(response.toString());
  }

  if (digit === '9') {
    // Read cart and create quote
    if (session.cart && session.cart.length > 0) {
      const total = session.cart.reduce((sum, item) => sum + item.price, 0);
      response.say(`Your cart has ${session.cart.length} items, total ${total.toFixed(2)} dollars.`);
      response.say('Thank you for your quote request. Our sales team will contact you shortly.');
      response.say('Goodbye!');
      response.hangup();
      delete sessions[callSid];
    } else {
      response.say('Your cart is empty.');
      response.redirect('/process-speech'); // Go back to product listing
    }
    return res.type('text/xml').send(response.toString());
  }

  const index = parseInt(digit, 10) - 1;
  if (index >= 0 && index < session.searchResults.length) {
    session.cart = session.cart || [];
    const item = session.searchResults[index];
    session.cart.push(item);
    response.say(`${item.title} added to your cart.`);
    // Repeat choices
    session.searchResults.forEach((p, i) => {
      response.say(`Press ${i + 1} to add ${p.title} priced at ${p.price} dollars to your cart.`);
    });
    response.say('Press 9 to hear your cart and get a quote.');
    response.say('Press 0 to end the call.');

    const gather = response.gather({
      numDigits: 1,
      action: '/handle-choice',
      method: 'POST',
      timeout: 10
    });
    return res.type('text/xml').send(response.toString());
  }

  // Invalid input
  response.say('Invalid choice. Please try again.');
  response.redirect('/process-speech');
  return res.type('text/xml').send(response.toString());
});

// Start Express server
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server listening on port ${port}`));












