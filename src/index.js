// backend/server.js
// Node 18+ recommended
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
//const { Configuration, OpenAIApi } = require('openai');
const { OpenAI } = require('openai');
const { twiml: { VoiceResponse } } = require('twilio');
const products = require('./products.json'); // sample catalog file

require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false })); // for Twilio
app.use(bodyParser.json()); // for frontend

// OpenAI setup (expect OPENAI_API_KEY in env)
// const openaiConfig = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
// const openai = new OpenAIApi(openaiConfig);


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });



// --- Helper: call OpenAI to extract structured info ---
async function parseVehicleInfo(transcript) {
  const prompt = `
You are an assistant that extracts vehicle search fields from user speech.
Input: a single sentence where a person says what they want.
Return ONLY valid JSON with keys: year (string), make (string), model (string), item (string), extras (array of strings).
If a field isn't present, set it to an empty string or empty array.
Examples:
  Input: "2018 Toyota Camry brake pads"
  Output: {"year":"2018","make":"Toyota","model":"Camry","item":"brake pads","extras":[]}
Now extract from this input:
"${transcript}"
`;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0
    });
    const text = resp.choices[0].message.content.trim();

    // Defensive parse: try to find JSON substring
    const jsonStart = text.indexOf('{');
    const jsonText = jsonStart >= 0 ? text.slice(jsonStart) : text;
    return JSON.parse(jsonText);
  } catch (err) {
    console.error('OpenAI parse error:', err?.response?.data || err.message || err);
    return { year: '', make: '', model: '', item: '', extras: [] };
  }
}

// --- Simple product search reusing earlier logic ---
function searchParts(year, make, model, item) {
  const qYear = (year || '').toString();
  const qMake = (make || '').toLowerCase();
  const qModel = (model || '').toLowerCase();
  const qItem = (item || '').toLowerCase();

  return products.filter(p => {
    // fitment check
    const fits = p.fits || [];
    const fitMatch = fits.some(f => {
      const yearMatch = !qYear || f.year.toString() === qYear;
      const makeMatch = !qMake || f.make.toLowerCase() === qMake;
      const modelMatch = !qModel || f.model.toLowerCase() === qModel;
      return yearMatch && makeMatch && modelMatch;
    });
    const itemMatch = !qItem || p.title.toLowerCase().includes(qItem) || p.partType.toLowerCase().includes(qItem);
    return fitMatch && itemMatch;
  });
}

// ---------- API used by frontend (local UI) ----------
app.post('/api/parse-and-search', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });
  const parsed = await parseVehicleInfo(transcript);
  const results = searchParts(parsed.year, parsed.make, parsed.model, parsed.item);
  res.json({ parsed, results });
});

// ---------- Twilio voice endpoints (inbound call flow) ----------
/*
  /voice
    -> Twilio posts here on incoming call
    -> Responds with <Gather input="speech"> to capture caller speech
  /process-speech
    -> Twilio posts speech result to this endpoint
    -> parse using OpenAI, search, respond with TwiML <Say> and <Gather digits> for choices
  /handle-choice
    -> Twilio posts digit pressed; manage cart in-memory per CallSid (demo)
*/

const sessions = {}; // in-memory; for demo only

app.post('/voice', (req, res) => {
  const vr = new VoiceResponse();
  const gather = vr.gather({
    input: 'speech',
    action: '/process-speech',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'Toyota, Honda, Camry, Accord, brake pads, oil filter'
  });
  gather.say('Welcome to Auto Parts Finder. Please say the year, make, model, and the part you need.');
  // If no input, repeat
  vr.redirect('/voice');
  res.type('text/xml').send(vr.toString());
});

app.post('/process-speech', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult || '';
  const vr = new VoiceResponse();

  const parsed = await parseVehicleInfo(speech);
  const results = searchParts(parsed.year, parsed.make, parsed.model, parsed.item);

  // Save session
  sessions[callSid] = sessions[callSid] || { cart: [] };
  sessions[callSid].parsed = parsed;
  sessions[callSid].results = results;

  if (!results || results.length === 0) {
    vr.say(`Sorry, I couldn't find parts for ${parsed.year} ${parsed.make} ${parsed.model} ${parsed.item}. Please try again.`);
    vr.redirect('/voice');
    return res.type('text/xml').send(vr.toString());
  }

  vr.say(`I found ${results.length} items for ${parsed.year} ${parsed.make} ${parsed.model}.`);

  // read top 5 with a digit choice
  results.slice(0, 5).forEach((p, i) => {
    vr.say(`Press ${i + 1} to add ${p.title} priced at ${p.price} dollars to your cart.`);
  });
  vr.say('Press 9 to hear your cart and get a quote. Press 0 to end this call.');

  vr.gather({ numDigits: 1, action: '/handle-choice', method: 'POST', timeout: 12 });
  res.type('text/xml').send(vr.toString());
});

app.post('/handle-choice', (req, res) => {
  const callSid = req.body.CallSid;
  const digit = req.body.Digits;
  const vr = new VoiceResponse();
  const session = sessions[callSid];

  if (!session || !session.results) {
    vr.say('Session expired. Let us start over.');
    vr.redirect('/voice');
    return res.type('text/xml').send(vr.toString());
  }

  if (digit === '0') {
    vr.say('Thank you for calling. Goodbye.');
    vr.hangup();
    delete sessions[callSid];
    return res.type('text/xml').send(vr.toString());
  }

  if (digit === '9') {
    const cart = session.cart || [];
    if (cart.length === 0) {
      vr.say('Your cart is empty.');
      vr.redirect('/process-speech');
      return res.type('text/xml').send(vr.toString());
    }
    const total = cart.reduce((s, it) => s + it.price, 0).toFixed(2);
    vr.say(`Your cart has ${cart.length} items. Total is ${total} dollars. We will email your quote. Goodbye.`);
    vr.hangup();
    delete sessions[callSid];
    return res.type('text/xml').send(vr.toString());
  }

  // add item mapping
  const idx = parseInt(digit, 10) - 1;
  if (idx >= 0 && idx < session.results.length) {
    session.cart.push(session.results[idx]);
    vr.say(`${session.results[idx].title} added to cart.`);
    // repeat choices
    session.results.slice(0, 5).forEach((p, i) => {
      vr.say(`Press ${i + 1} to add ${p.title}.`);
    });
    vr.say('Press 9 to hear your cart and get a quote. Press 0 to end this call.');
    vr.gather({ numDigits: 1, action: '/handle-choice', method: 'POST', timeout: 12 });
    return res.type('text/xml').send(vr.toString());
  }

  vr.say('Sorry, invalid choice. Redirecting to start.');
  vr.redirect('/voice');
  res.type('text/xml').send(vr.toString());
});

// start
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
