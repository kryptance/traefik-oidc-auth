const http = require('http');

class OTLPCollectorMock {
  constructor() {
    this.traces = [];
    this.server = null;
  }

  start(port = 4318) {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/traces') {
          let body = '';
          
          req.on('data', chunk => {
            body += chunk.toString();
          });
          
          req.on('end', () => {
            try {
              const trace = JSON.parse(body);
              this.traces.push(trace);
              console.log(`Received trace with ${this.countSpans(trace)} spans`);
              
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ partialSuccess: {} }));
            } catch (e) {
              console.error('Failed to parse trace:', e);
              res.writeHead(400);
              res.end('Bad Request');
            }
          });
        } else if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'ok', 
            traces: this.traces.length,
            totalSpans: this.traces.reduce((sum, t) => sum + this.countSpans(t), 0)
          }));
        } else if (req.method === 'GET' && req.url === '/traces') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.traces));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });
      
      this.server.listen(port, () => {
        console.log(`OTLP Collector Mock listening on port ${port}`);
        resolve();
      });
    });
  }
  
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }
  
  countSpans(trace) {
    let count = 0;
    if (trace.resourceSpans) {
      for (const rs of trace.resourceSpans) {
        if (rs.scopeSpans) {
          for (const ss of rs.scopeSpans) {
            if (ss.spans) {
              count += ss.spans.length;
            }
          }
        }
      }
    }
    return count;
  }
  
  getTraces() {
    return this.traces;
  }
  
  clearTraces() {
    this.traces = [];
  }
}

// If run directly, start the server
if (require.main === module) {
  const port = process.env.PORT || 4318;
  const collector = new OTLPCollectorMock();
  
  collector.start(port).then(() => {
    console.log('OTLP Collector Mock is running');
    console.log(`Health check: http://localhost:${port}/health`);
    console.log(`View traces: http://localhost:${port}/traces`);
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await collector.stop();
    process.exit(0);
  });
}

module.exports = OTLPCollectorMock;