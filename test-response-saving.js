#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

async function testResponseSaving() {
  const sessionsDir = path.join(os.homedir(), '.oracle', 'sessions');
  
  try {
    // List all session directories
    const entries = await fs.readdir(sessionsDir);
    console.log(`Found ${entries.length} session(s)`);
    
    for (const entry of entries) {
      const sessionDir = path.join(sessionsDir, entry);
      const responseFile = path.join(sessionDir, 'response.md');
      
      try {
        await fs.access(responseFile);
        const stats = await fs.stat(responseFile);
        console.log(`✅ Session ${entry}: response.md exists (${stats.size} bytes)`);
      } catch (err) {
        console.log(`❌ Session ${entry}: response.md not found`);
      }
    }
  } catch (err) {
    console.error('Error reading sessions directory:', err.message);
  }
}

testResponseSaving();
