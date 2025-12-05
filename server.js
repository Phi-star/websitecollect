const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Load configuration
let config = {};
try {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
} catch (error) {
    console.log('No config file found. Using defaults.');
}

// Store sessions (in production, use Redis or database)
const sessions = new Map();

// Login to a website
app.post('/api/login', async (req, res) => {
    try {
        const { url, email, password, customSelectors } = req.body;
        
        if (!url || !email || !password) {
            return res.status(400).json({ error: 'URL, email, and password are required' });
        }

        console.log(`Attempting login to: ${url}`);

        // First, visit the login page to get cookies and CSRF tokens
        const loginPageResponse = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            maxRedirects: 5,
            timeout: 15000
        });

        const $ = cheerio.load(loginPageResponse.data);
        const cookies = loginPageResponse.headers['set-cookie'] || [];

        // Auto-detect form fields
        const form = $('form').first();
        const formAction = form.attr('action') || url;
        const formMethod = (form.attr('method') || 'POST').toUpperCase();
        const formUrl = new URL(formAction, url).href;

        // Find input fields
        const inputs = {};
        $('form input').each((i, elem) => {
            const name = $(elem).attr('name');
            const type = $(elem).attr('type');
            const value = $(elem).attr('value') || '';
            
            if (name) {
                inputs[name] = {
                    name,
                    type,
                    originalValue: value,
                    suggestedValue: ''
                };
                
                // Auto-suggest values based on field names
                const nameLower = name.toLowerCase();
                if (nameLower.includes('email') || nameLower.includes('user') || nameLower.includes('login')) {
                    inputs[name].suggestedValue = email;
                } else if (nameLower.includes('pass')) {
                    inputs[name].suggestedValue = password;
                } else if (nameLower.includes('csrf') || nameLower.includes('token')) {
                    inputs[name].suggestedValue = value; // Keep original CSRF
                }
            }
        });

        // Use custom selectors if provided, otherwise use auto-detected
        const loginData = {};
        if (customSelectors && Object.keys(customSelectors).length > 0) {
            Object.assign(loginData, customSelectors);
        } else {
            // Auto-fill based on field analysis
            Object.keys(inputs).forEach(key => {
                if (inputs[key].suggestedValue !== '') {
                    loginData[key] = inputs[key].suggestedValue;
                } else {
                    loginData[key] = inputs[key].originalValue;
                }
            });
        }

        console.log('Login data:', JSON.stringify(loginData, null, 2));

        // Prepare headers for login request
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Origin': new URL(url).origin,
            'Referer': url
        };

        // Add cookies if any
        if (cookies.length > 0) {
            headers['Cookie'] = cookies.join('; ');
        }

        // Perform login
        const loginResponse = await axios({
            method: formMethod,
            url: formUrl,
            data: new URLSearchParams(loginData).toString(),
            headers: headers,
            maxRedirects: 5,
            timeout: 20000,
            validateStatus: (status) => status < 500 // Allow redirects
        });

        // Store session data
        const sessionId = 'session_' + Date.now();
        const sessionData = {
            url: url,
            cookies: loginResponse.headers['set-cookie'] || cookies,
            finalUrl: loginResponse.request.res.responseUrl || formUrl,
            headers: loginResponse.headers,
            timestamp: new Date().toISOString()
        };

        sessions.set(sessionId, sessionData);

        // Parse response
        const responseHTML = loginResponse.data;
        const $response = cheerio.load(responseHTML);
        
        // Check if login was successful
        const pageTitle = $response('title').text();
        const bodyText = $response('body').text().toLowerCase();
        
        const successIndicators = [
            bodyText.includes('dashboard'),
            bodyText.includes('welcome'),
            bodyText.includes('logout'),
            bodyText.includes('my account'),
            pageTitle.toLowerCase().includes('dashboard'),
            !bodyText.includes('invalid'),
            !bodyText.includes('incorrect'),
            !bodyText.includes('login failed')
        ];

        const isSuccess = successIndicators.filter(Boolean).length > 2;

        res.json({
            success: isSuccess,
            sessionId: sessionId,
            message: isSuccess ? 'Login successful!' : 'Login may have failed - check response',
            finalUrl: sessionData.finalUrl,
            title: pageTitle,
            cookies: sessionData.cookies,
            detectedForm: {
                action: formAction,
                method: formMethod,
                inputs: inputs
            },
            responsePreview: responseHTML.substring(0, 2000) + (responseHTML.length > 2000 ? '...' : '')
        });

    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ 
            error: 'Login failed', 
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Fetch protected content using session
app.get('/api/fetch-protected', async (req, res) => {
    try {
        const { sessionId, path } = req.query;
        
        if (!sessionId || !sessions.has(sessionId)) {
            return res.status(400).json({ error: 'Invalid or expired session' });
        }

        const session = sessions.get(sessionId);
        const targetUrl = path ? new URL(path, session.finalUrl).href : session.finalUrl;

        // Fetch protected content with stored cookies
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': session.finalUrl
        };

        if (session.cookies && session.cookies.length > 0) {
            headers['Cookie'] = session.cookies.join('; ');
        }

        const response = await axios.get(targetUrl, {
            headers: headers,
            maxRedirects: 5,
            timeout: 15000,
            validateStatus: () => true
        });

        const $ = cheerio.load(response.data);
        
        // Extract all resources
        const resources = {
            html: response.data,
            scripts: [],
            styles: [],
            images: [],
            links: [],
            forms: []
        };

        // Extract scripts
        $('script[src]').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                resources.scripts.push(new URL(src, targetUrl).href);
            }
        });

        // Extract inline scripts
        $('script:not([src])').each((i, elem) => {
            const content = $(elem).html();
            if (content && content.trim().length > 0) {
                resources.scripts.push(`Inline script #${i + 1}: ${content.substring(0, 100)}...`);
            }
        });

        // Extract styles
        $('link[rel="stylesheet"]').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href) {
                resources.styles.push(new URL(href, targetUrl).href);
            }
        });

        // Extract forms
        $('form').each((i, form) => {
            resources.forms.push({
                action: $(form).attr('action'),
                method: $(form).attr('method') || 'GET',
                inputs: $(form).find('input').map((j, input) => ({
                    name: $(input).attr('name'),
                    type: $(input).attr('type'),
                    value: $(input).attr('value')
                })).get()
            });
        });

        res.json({
            success: true,
            url: targetUrl,
            title: $('title').text(),
            statusCode: response.status,
            resources: resources,
            htmlPreview: response.data.substring(0, 5000),
            fullSize: response.data.length,
            downloadLink: `/api/download-html/${encodeURIComponent(targetUrl)}?sessionId=${sessionId}`
        });

    } catch (error) {
        console.error('Fetch error:', error.message);
        res.status(500).json({ error: 'Failed to fetch protected content', details: error.message });
    }
});

// Download HTML content
app.get('/api/download-html/:url', async (req, res) => {
    try {
        const { sessionId } = req.query;
        const targetUrl = decodeURIComponent(req.params.url);
        
        if (!sessionId || !sessions.has(sessionId)) {
            return res.status(400).send('Invalid session');
        }

        const session = sessions.get(sessionId);
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': session.cookies?.join('; ') || ''
        };

        const response = await axios.get(targetUrl, { headers });
        
        const filename = `protected_page_${Date.now()}.html`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'text/html');
        res.send(response.data);

    } catch (error) {
        res.status(500).send('Download failed');
    }
});

// Clear session
app.delete('/api/session/:id', (req, res) => {
    sessions.delete(req.params.id);
    res.json({ success: true, message: 'Session cleared' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Auto Login Tool running on http://localhost:${PORT}`);
    console.log('⚠️  WARNING: Only use on websites you own or have permission to test!');
});
