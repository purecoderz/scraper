const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const dns = require('dns').promises;
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();

app.use(express.json());
app.use(cors());

// --- Helper: Validate DNS ---
async function validateDomain(email) {
    try {
        const domain = email.split('@')[1];
        if (!domain) return false;
        const mxRecords = await dns.resolveMx(domain);
        return mxRecords && mxRecords.length > 0;
    } catch (error) {
        return false;
    }
}

app.get('/', (req, res) => res.send('Scraper is running!'));

app.post('/scrape', async (req, res) => {
    let { url } = req.body;

    if (!url) return res.status(200).json({ success: false, error: 'Missing url' }); // CHANGED to 200
    if (!url.startsWith('http')) url = 'https://' + url;

    try {
        console.log(`\n--- Starting scrape for: ${url} ---`);

        // 1. SSL FIX
        const agent = new https.Agent({  
            rejectUnauthorized: false 
        });

        // 2. STEALTH HEADERS
        const axiosConfig = {
            timeout: 20000, 
            httpsAgent: agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1'
            }
        };

        if (process.env.PROXY_URL) {
            console.log("Using Proxy...");
            const proxyAgent = new HttpsProxyAgent(process.env.PROXY_URL, { rejectUnauthorized: false });
            axiosConfig.httpsAgent = proxyAgent;
            axiosConfig.proxy = false; 
        }

        const response = await axios.get(url, axiosConfig);
        const $ = cheerio.load(response.data);

        // --- Extraction Logic ---
        const bodyText = $('body').text();
        const mailtoLinks = [];
        $('a[href^="mailto:"]').each((i, elem) => {
            let email = $(elem).attr('href').replace(/^mailto:/i, '').split('?')[0];
            if (email) mailtoLinks.push(email);
        });

        const contentToSearch = bodyText + " " + mailtoLinks.join(" ");
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
        const matches = contentToSearch.match(emailRegex);

        let uniqueEmails = [];
        let validEmails = [];

        if (matches) {
            uniqueEmails = [...new Set(matches.map(e => e.toLowerCase()))];
            uniqueEmails = uniqueEmails.filter(email => {
                const invalidExtensions = ['.png', '.jpg', '.jpeg', '.js', '.css', '.svg', '.gif', '.webp', '.woff', '.mp4'];
                return !invalidExtensions.some(ext => email.endsWith(ext));
            });

            console.log(`Found ${uniqueEmails.length} candidates. Validating DNS...`);
            const validationResults = await Promise.all(
                uniqueEmails.map(async (email) => {
                    const isValid = await validateDomain(email);
                    return isValid ? email : null;
                })
            );
            validEmails = validationResults.filter(e => e !== null);
        }

        console.log(`Success! Found ${validEmails.length} valid emails.`);

        res.json({
            success: true,
            url: url,
            candidates_found: uniqueEmails.length,
            valid_emails_count: validEmails.length,
            emails: validEmails
        });

    } catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        
        // IMPORTANT CHANGE HERE:
        // We now return status 200 even if it failed.
        // This stops n8n from crashing.
        res.status(200).json({
            success: false,
            url: url,
            error: error.message, // The error message is still here for you to see
            emails: []
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});