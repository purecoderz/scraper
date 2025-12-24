const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const dns = require('dns').promises; // Built-in Node.js module
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

/**
 * HELPER: Validates if a domain has valid Mail Exchange (MX) records.
 * Returns true if the domain can receive email.
 */
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

/**
 * ROOT ROUTE: Health check
 */
app.get('/', (req, res) => {
    res.send('Scraper is running!');
});

/**
 * SCRAPE ROUTE: The main logic
 */
app.post('/scrape', async (req, res) => {
    let { url } = req.body;

    // 1. Input Validation
    if (!url) {
        return res.status(400).json({ error: 'Missing url' });
    }
    if (!url.startsWith('http')) {
        url = 'https://' + url;
    }

    try {
        console.log(`\n--- Starting scrape for: ${url} ---`);

        // 2. Configure Axios (Headers + Proxy)
        const axiosConfig = {
            timeout: 15000, // 15 seconds timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        };

        // Check for Proxy in Environment Variables (for Render/Heroku)
        if (process.env.PROXY_URL) {
            console.log("Using Proxy connection...");
            const agent = new HttpsProxyAgent(process.env.PROXY_URL);
            axiosConfig.httpsAgent = agent;
            axiosConfig.proxy = false; // Disable default axios proxy to use the agent
        }

        // 3. Fetch the Page
        const response = await axios.get(url, axiosConfig);
        const html = response.data;
        const $ = cheerio.load(html);

        // 4. Extraction Strategy
        // Get visible text
        const bodyText = $('body').text();
        
        // Get specific mailto links (often hidden in buttons)
        const mailtoLinks = [];
        $('a[href^="mailto:"]').each((i, elem) => {
            // Clean up 'mailto:user@example.com?subject=...' -> 'user@example.com'
            let email = $(elem).attr('href').replace(/^mailto:/i, '').split('?')[0];
            if (email) mailtoLinks.push(email);
        });

        // Combine sources for regex search
        const contentToSearch = bodyText + " " + mailtoLinks.join(" ");

        // 5. Regex Matching
        // Matches standard emails. explicitly looks for a dot and at least 2 chars for extension
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
        const matches = contentToSearch.match(emailRegex);

        let uniqueEmails = [];
        let validEmails = [];

        if (matches) {
            // Deduplicate and lower case
            uniqueEmails = [...new Set(matches.map(e => e.toLowerCase()))];

            // Filter out common false positives (images, scripts, etc.)
            uniqueEmails = uniqueEmails.filter(email => {
                const invalidExtensions = ['.png', '.jpg', '.jpeg', '.js', '.css', '.svg', '.gif', '.webp', '.woff', '.mp4'];
                return !invalidExtensions.some(ext => email.endsWith(ext));
            });

            // 6. DNS Validation (Parallel Processing)
            console.log(`Found ${uniqueEmails.length} candidates. Validating DNS...`);
            
            const validationResults = await Promise.all(
                uniqueEmails.map(async (email) => {
                    const isValid = await validateDomain(email);
                    return isValid ? email : null;
                })
            );

            // Remove nulls
            validEmails = validationResults.filter(e => e !== null);
        }

        console.log(`Success! Found ${validEmails.length} valid emails.`);

        // 7. Send Response
        res.json({
            success: true,
            url: url,
            candidates_found: uniqueEmails.length,
            valid_emails_count: validEmails.length,
            emails: validEmails
        });

    } catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        
        // Handle specific Axios errors (like 403 Forbidden)
        let errorMessage = error.message;
        if (error.response && error.response.status === 403) {
            errorMessage = "Access Forbidden (403). The site blocked the scraper.";
        } else if (error.code === 'ECONNABORTED') {
            errorMessage = "Request Timed Out. The site took too long to respond.";
        }

        res.status(500).json({
            success: false,
            url: url,
            error: errorMessage,
            emails: []
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});