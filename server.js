const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
    res.send('Scraper is running!');
});

app.post('/scrape', async (req, res) => {
    let { url } = req.body;

    // 1. Basic Validation
    if (!url) {
        return res.status(400).json({ error: 'Missing url' });
    }
    if (!url.startsWith('http')) {
        url = 'https://' + url;
    }

    try {
        // 2. Request the page
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);

        // 3. Extraction Strategy: 
        // Instead of raw HTML (which catches image sources and class names), 
        // we grab visible text AND specific mailto links.
        const bodyText = $('body').text();
        
        const mailtoLinks = [];
        $('a[href^="mailto:"]').each((i, elem) => {
            // Remove 'mailto:' prefix and query params (e.g. ?subject=...)
            let email = $(elem).attr('href').replace(/^mailto:/, '').split('?')[0];
            mailtoLinks.push(email);
        });

        // Combine text and mailto links for searching
        const contentToSearch = bodyText + " " + mailtoLinks.join(" ");

        // 4. Improved Regex
        // Matches standard emails, escapes the dot before the extension, and ensures extension length (2+)
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
        
        const matches = contentToSearch.match(emailRegex);

        // 5. Deduplicate and clean
        let uniqueEmails = [];
        if (matches) {
            uniqueEmails = [...new Set(matches.map(e => e.toLowerCase()))];
            
            // Final filter to remove common false positives if they slipped through
            uniqueEmails = uniqueEmails.filter(email => {
                const invalidExtensions = ['.png', '.jpg', '.jpeg', '.js', '.css', '.svg', '.gif', '.webp'];
                return !invalidExtensions.some(ext => email.endsWith(ext));
            });
        }

        res.json({
            success: true,
            url: url,
            count: uniqueEmails.length,
            emails: uniqueEmails
        });

    } catch (error) {
        // Return valid JSON even on error, with the status code
        console.error(`Error scraping ${url}:`, error.message);
        res.status(500).json({
            success: false,
            url: url,
            error: error.message,
            emails: []
        });
    }
});

const PORT = process.env.PORT || 3000;

// FIX: Used backticks (`) for string interpolation, not double quotes (")
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});