// server.js
// Entry point. Boots Express, loads the knowledge base once at startup,
// and mounts the chat API.

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const chatRoutes = require('./routes/chat');
const { loadKnowledgeBase } = require('./knowledge');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Simple request logger — useful while wiring support.html to this API
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.use('/api/chat', chatRoutes);

// Central error handler — anything thrown/rejected in routes lands here
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

async function start() {
  // Knowledge base (markdown/pdf/docx/json/txt) is parsed once at boot,
  // not on every request — see knowledge.js
  await loadKnowledgeBase();
  app.listen(PORT, () => {
    console.log(`AI Support System listening on port ${PORT}`);
  });
}

start();
