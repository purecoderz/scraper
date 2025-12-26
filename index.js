const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const dns = require('dns').promises;
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const urlParser = require('url');

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

// --- Helper: Create Axios Instance with Stealth Config ---
function createAxiosInstance() {
    const agent = new https.Agent({ rejectUnauthorized: false });
    
    const config = {
        timeout: 15000, 
        httpsAgent: agent,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
    };

    if (process.env.PROXY_URL) {
        console.log("Using Proxy...");
        const proxyAgent = new HttpsProxyAgent(process.env.PROXY_URL, { rejectUnauthorized: false });
        config.httpsAgent = proxyAgent;
        config.proxy = false;
    }

    return axios.create(config);
}

// --- Helper: Extract Emails from HTML ---
function extractEmails(html) {
    const $ = cheerio.load(html);
    const bodyText = $('body').text();
    const mailtoLinks = [];
    
    $('a[href^="mailto:"]').each((i, elem) => {
        let email = $(elem).attr('href').replace(/^mailto:/i, '').split('?')[0];
        if (email) mailtoLinks.push(email);
    });

    const contentToSearch = bodyText + " " + mailtoLinks.join(" ");
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
    const matches = contentToSearch.match(emailRegex);

    if (!matches) return [];

    let uniqueEmails = [...new Set(matches.map(e => e.toLowerCase()))];
    // Filter junk extensions
    return uniqueEmails.filter(email => {
        const invalidExtensions = ['.png', '.jpg', '.jpeg', '.js', '.css', '.svg', '.gif', '.webp', '.woff', '.mp4'];
        return !invalidExtensions.some(ext => email.endsWith(ext));
    });
}

// --- NEW Helper: Extract Social Media Links ---
function extractSocials(html) {
    const $ = cheerio.load(html);
    const socials = {
        facebook: [],
        twitter: [],
        linkedin: [],
        instagram: [],
        youtube: [],
        tiktok: []
    };

    $('a').each((i, elem) => {
        const href = $(elem).attr('href');
        if (!href) return;

        // Convert to lowercase for checking, but keep original for storage
        const lowerHref = href.toLowerCase();

        // Basic filtering to avoid "share" links if possible
        if (lowerHref.includes('share') || lowerHref.includes('intent/tweet')) return;

        if (lowerHref.includes('facebook.com')) socials.facebook.push(href);
        else if (lowerHref.includes('twitter.com') || lowerHref.includes('x.com')) socials.twitter.push(href);
        else if (lowerHref.includes('linkedin.com')) socials.linkedin.push(href);
        else if (lowerHref.includes('instagram.com')) socials.instagram.push(href);
        else if (lowerHref.includes('youtube.com')) socials.youtube.push(href);
        else if (lowerHref.includes('tiktok.com')) socials.tiktok.push(href);
    });

    // Deduplicate each array
    for (const key in socials) {
        socials[key] = [...new Set(socials[key])];
    }

    return socials;
}

// --- Helper: Merge Social Objects ---
function mergeSocials(existing, newSocials) {
    const merged = { ...existing };
    for (const key in newSocials) {
        merged[key] = [...new Set([...(merged[key] || []), ...newSocials[key]])];
    }
    return merged;
}

// --- Helper: Find "Contact" Page Link ---
function findContactLink(html, baseUrl) {
    const $ = cheerio.load(html);
    let contactUrl = null;

    $('a').each((i, elem) => {
        const text = $(elem).text().toLowerCase();
        const href = $(elem).attr('href');
        
        if (href && (text.includes('contact') || text.includes('about') || href.includes('contact'))) {
            contactUrl = urlParser.resolve(baseUrl, href);
            return false; 
        }
    });
    return contactUrl;
}

app.get('/', (req, res) => res.send('Scraper is running!'));

app.post('/scrape', async (req, res) => {
    let { url } = req.body;

    if (!url) return res.status(200).json({ success: false, error: 'Missing url' });
    if (!url.startsWith('http')) url = 'https://' + url;

    try {
        console.log(`\n--- Starting scrape for: ${url} ---`);
        const axiosInstance = createAxiosInstance();

        // 1. Scrape Homepage
        const response = await axiosInstance.get(url);
        let foundEmails = extractEmails(response.data);
        let foundSocials = extractSocials(response.data); // <--- Extract Socials Here
        
        console.log(`Homepage: ${foundEmails.length} emails, Socials found.`);

        // 2. Deep Crawl Strategy
        if (foundEmails.length === 0) {
            const contactUrl = findContactLink(response.data, url);
            if (contactUrl) {
                console.log(`Deep Crawl: Visiting ${contactUrl}`);
                try {
                    const contactResponse = await axiosInstance.get(contactUrl);
                    
                    const contactEmails = extractEmails(contactResponse.data);
                    foundEmails = [...foundEmails, ...contactEmails];

                    const contactSocials = extractSocials(contactResponse.data); // <--- Extract Socials on Contact pg
                    foundSocials = mergeSocials(foundSocials, contactSocials); // <--- Merge results

                    console.log(`Contact Page: ${contactEmails.length} emails found.`);
                } catch (err) {
                    console.log(`Failed to scrape contact page: ${err.message}`);
                }
            } else {
                console.log("No 'Contact' link found on homepage.");
            }
        }

        // Deduplicate emails
        foundEmails = [...new Set(foundEmails)];

        // 3. DNS Validation
        let validEmails = [];
        if (foundEmails.length > 0) {
            console.log(`Validating DNS for ${foundEmails.length} candidates...`);
            const validationResults = await Promise.all(
                foundEmails.map(async (email) => {
                    const isValid = await validateDomain(email);
                    return isValid ? email : null;
                })
            );
            validEmails = validationResults.filter(e => e !== null);
        }

        console.log(`Final Result: ${validEmails.length} valid emails.`);

        res.json({
            success: true,
            url: url,
            candidates_found: foundEmails.length,
            valid_emails_count: validEmails.length,
            emails: validEmails,
            social_media: foundSocials // <--- Added to response
        });

    } catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        
        res.status(200).json({
            success: false,
            url: url,
            error: error.message,
            emails: [],
            social_media: {}
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});