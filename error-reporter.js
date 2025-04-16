// errorReporter.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Joi = require('joi');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

// Dynamically import node-fetch for CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Gemini API configuration using Google Generative Language API endpoint
const GEMINI_API_URL =
  process.env.GEMINI_API_URL ||
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const GEMINI_API_KEY = "Your gemini api"; // Must be set in your environment

// Logger setup: logs both to console and 'error.log' with timestamps in JSON format.
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(), // automatically adds timestamps
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log' }),
  ],
});

// Rate limiting middleware: limits each IP to 100 requests per minute.
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
});

// Joi schema to validate incoming error payloads.
const errorSchema = Joi.object({
  errorMessage: Joi.string().required(),
  url: Joi.string().uri().required(),
  line: Joi.number().integer().required(),
  column: Joi.number().integer().required(),
  errorStack: Joi.string().allow(null),
});

// Function to call Gemini (Google Generative Language API) for error analysis.
// It constructs a prompt from error details and returns the recommendation from the response.
async function analyzeErrorWithGemini({ errorMessage, url, line, column, errorStack }) {
  if (!GEMINI_API_KEY) {
    console.warn("Gemini API Key not set. Skipping external error analysis.");
    return "Gemini API Key not set. Please configure GEMINI_API_KEY.";
  }

  // Construct the full URL including the API key.
  const fullUrl = `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`;

  // Build the prompt using the error details.
  const prompt = `You are an expert software engineer. Based on the following error details, please provide a clear recommendation on how to fix the error within 60 words:
Error Message: "${errorMessage}"
Location: ${url} at line ${line}, column ${column}
Stack Trace: ${errorStack || 'No stack available'}
Recommendation:`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ]
  };

  try {
    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const errorDetails = await response.text();
      console.error("Gemini API responded with an error:", errorDetails);
      return "Gemini API error: Unable to retrieve recommendation.";
    }

    const geminiData = await response.json();
    // Log full response for debugging.
    console.log("Full Gemini API response:", JSON.stringify(geminiData, null, 2));

    // Extract recommendation text from the correct field.
    if (geminiData.candidates && geminiData.candidates.length > 0) {
      const candidate = geminiData.candidates[0];
      const recommendation = candidate.content &&
                             candidate.content.parts &&
                             candidate.content.parts[0] &&
                             candidate.content.parts[0].text;
      return recommendation ? recommendation : "No recommendation provided by Gemini API.";
    }
    return "No recommendation provided by Gemini API.";
  } catch (err) {
    console.error("Error calling Gemini API:", err);
    return "Error calling Gemini API.";
  }
}

// Endpoint to report errors.
app.post('/report-error', limiter, async (req, res) => {
  const { errorMessage, url, line, column, errorStack } = req.body;
  // Validate the incoming error payload.
  const { error } = errorSchema.validate(req.body);
  if (error) {
    return res.status(400).send({ message: error.details[0].message });
  }

  // Retrieve recommendation from Gemini API.
  const recommendation = await analyzeErrorWithGemini({ errorMessage, url, line, column, errorStack });

  // Log the error with the Gemini recommendation.
  logger.info(errorMessage, { errorMessage, url, line, column, errorStack, recommendation });
  res.status(200).send({ message: errorMessage, recommendation });
});

// API endpoint to retrieve log entries as JSON.
app.get('/api/logs', (req, res) => {
  const logFilePath = path.join(__dirname, 'error.log');
  fs.readFile(logFilePath, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ message: 'Could not read log file' });
    }
    // Split the log file by newlines and parse each log entry.
    const logs = data
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return { raw: line };
        }
      });
    res.json({ logs });
  });
});

// Frontend endpoint: Display logs in a Sentry-like, auto-updating interface with recommendations.
app.get('/logs', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Error Logs</title>
    <style>
      body {
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background: #1e1e2f;
        color: #e0e0e0;
        margin: 0;
        padding: 20px;
      }
      .container {
        max-width: 1200px;
        margin: 0 auto;
      }
      h1 {
        text-align: center;
        margin-bottom: 20px;
      }
      .card {
        background: #262636;
        padding: 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 10px;
      }
      th, td {
        padding: 12px 15px;
        text-align: left;
        border-bottom: 1px solid #444;
      }
      th {
        background: #3e3e5e;
      }
      tr:nth-child(even) { background: #2a2a3a; }
      tr:hover { background: #444; }
      pre {
        white-space: pre-wrap;
        word-wrap: break-word;
        font-size: 0.9em;
      }
      .refresh-info {
        text-align: center;
        color: #aaa;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Error Logs</h1>
      <div class="card">
        <table id="logs-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Level</th>
              <th>Message</th>
              <th>Meta Data</th>
              <th>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            <!-- Rows will be populated here -->
          </tbody>
        </table>
      </div>
      <div class="refresh-info">
        <small>Auto-refreshing every 10 seconds...</small>
      </div>
    </div>
    
    <script>
      async function fetchLogs() {
        try {
          const response = await fetch('/api/logs');
          const data = await response.json();
          const tbody = document.querySelector("#logs-table tbody");
          tbody.innerHTML = "";
          
          data.logs.forEach(log => {
            const tr = document.createElement("tr");
            const timestamp = log.timestamp || new Date().toISOString();
            const level = log.level || '';
            const message = log.message || '';
            const recommendation = log.recommendation || '';
            // Pretty-print the complete log entry
            const meta = JSON.stringify(log, null, 2);
  
            tr.innerHTML = \`
              <td>\${timestamp}</td>
              <td>\${level}</td>
              <td>\${message}</td>
              <td><pre>\${meta}</pre></td>
              <td>\${recommendation}</td>
            \`;
            tbody.appendChild(tr);
          });
        } catch (error) {
          console.error("Error fetching logs:", error);
        }
      }
      
      // Initial fetch and auto-refresh every 10 seconds.
      fetchLogs();
      setInterval(fetchLogs, 10000);
    </script>
  </body>
  </html>
  `;
  res.send(html);
});

// Function to start the error reporter on the specified port.
module.exports = function startErrorReporter(port = process.env.PORT || 3000) {
  app.listen(port, () => {
    logger.info(`Error reporter started on port ${port}`);
  });
};
