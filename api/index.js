export default function handler(req, res) {
  res.status(200).json({
    status: 'online',
    service: 'Vercel Auto Host Serverless API',
    timestamp: new Date().toISOString()
  });
}

