import express, { Request, Response } from 'express';
import session from 'express-session';
import cors from 'cors';
import fetch from 'node-fetch';
import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';

dotenv.config();

// Type definitions
interface TwitterSession extends session.Session {
    codeVerifier?: string;
    state?: string;
    accessToken?: string;
    refreshToken?: string;
    linkedin_state?: string;
    linkedin_accessToken?: string;
}

interface TwitterAuthResponse {
    url: string;
    codeVerifier: string;
    state: string;
}

interface LinkedInTokenResponse {
    access_token: string;
    error?: string;
    error_description?: string;
}

interface LinkedInProfileData {
    sub: string;
}

interface LinkedInPostPayload {
    author: string;
    lifecycleState: string;
    specificContent: {
        'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
                text: string;
            };
            shareMediaCategory: string;
            media: Array<{
                status: string;
                description: {
                    text: string;
                };
                originalUrl: string;
                title: {
                    text: string;
                };
            }>;
        };
    };
    visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' | 'CONNECTIONS';
    };
}

interface PostRequestBody {
    title: string;
    description?: string;
    url?: string;
}

const CALLBACK_URL = process.env.CALLBACK_URL;
const ORIGIN = process.env.ORIGIN;

const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const LINKEDIN_CALLBACK_URL = process.env.LINKEDIN_CALLBACK_URL;

const TWITTER_CLIENT_ID = process.env.TWITTER_CLIENT_ID;
const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;

const app = express();
const PORT = 3000;

app.set('trust proxy', 1);

app.use(cors({
    origin: ORIGIN,
    credentials: true
}));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Initialize Twitter client
const twitterClient = new TwitterApi({
    clientId: TWITTER_CLIENT_ID as string,
    clientSecret: TWITTER_CLIENT_SECRET
});

// Generate Twitter OAuth2 link
app.get('/auth/twitter', async (req: Request, res: Response) => {
    try {
        const { url, codeVerifier, state }: TwitterAuthResponse = twitterClient.generateOAuth2AuthLink(
            CALLBACK_URL as string,
            { scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] }
        );

        const session = req.session as TwitterSession;
        session.codeVerifier = codeVerifier;
        session.state = state;

        session.save((err: Error | null) => {
            if (err) {
                console.error('Session save error:', err);
                res.redirect('/callback.html');
                return;
            }
            console.log('Session after /auth/twitter:', session);
            res.json({ url });
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.redirect('/callback.html');
    }
});

// Handle Twitter callback
app.get('/callback', async (req: Request, res: Response) => {
    console.log('Incoming session in /callback:', req.session);

    try {
        const { code, state } = req.query as { code: string; state: string };
        const session = req.session as TwitterSession;

        const codeVerifier = session.codeVerifier;
        const sessionState = session.state;

        console.log('codeVerifier', codeVerifier);
        console.log('state', state);
        console.log('sessionState', sessionState);
        console.log('code', code);

        if (!codeVerifier || !state || !sessionState || !code) {
            return res.redirect('/callback.html');
        }

        if (state !== sessionState) {
            return res.redirect('/callback.html');
        }

        const {
            client: loggedClient,
            accessToken,
            refreshToken
        } = await twitterClient.loginWithOAuth2({
            code,
            codeVerifier,
            redirectUri: CALLBACK_URL as string
        });

        session.accessToken = accessToken;
        session.refreshToken = refreshToken;

        const user = await loggedClient.v2.me();

        res.redirect(`/callback.html?token=${accessToken}`);
    } catch (error) {
        console.error('Callback error:', error);
        res.redirect('/callback.html');
    }
});

// Generate LinkedIn OAuth2 link
app.get('/auth/linkedin', (req: Request, res: Response) => {
    const state = Math.random().toString(36).substring(7);
    const session = req.session as TwitterSession;
    session.linkedin_state = state;
    
    const linkedInConfig = {
        scopes: ["w_member_social", "openid", "profile", "email"],
    };

    const scope = encodeURIComponent(linkedInConfig.scopes.join(" "));
    res.json({
        url: `https://www.linkedin.com/oauth/v2/authorization?` +
            `response_type=code&` +
            `client_id=${LINKEDIN_CLIENT_ID}&` +
            `redirect_uri=${encodeURIComponent(LINKEDIN_CALLBACK_URL as string)}&` +
            `scope=${scope}&` +
            `state=${state}`
    });
});

// Handle LinkedIn callback
app.get('/callback/linkedin', async (req: Request, res: Response) => {
    const { code, state } = req.query as { code: string; state: string };
    const session = req.session as TwitterSession;
    const sessionState = session.linkedin_state;

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', LINKEDIN_CALLBACK_URL as string);
        params.append('client_id', LINKEDIN_CLIENT_ID as string);
        params.append('client_secret', LINKEDIN_CLIENT_SECRET as string);

        const tokenResponse = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const tokenData = await tokenResponse.json() as LinkedInTokenResponse;

        if (tokenData.error) {
            console.log('LinkedIn token error:', tokenData);
            return res.redirect('/callback.html');
        }

        const accessToken = tokenData.access_token;
        session.linkedin_accessToken = accessToken;

        res.redirect(`/callback.html?token=${accessToken}`);
    } catch (error) {
        console.error('LinkedIn callback error:', error);
        res.redirect('/callback.html');
    }
});

// Protected routes
app.post('/api/tweet', async (req: Request, res: Response): Promise<void | any> => {
    try {
        const session = req.session as TwitterSession;
        if (!session.accessToken) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const client = new TwitterApi(session.accessToken as string);
        const tweet = await client.v2.tweet(req.body.title);

        res.json(tweet);
    } catch (error) {
        console.error('Tweet error:', error);
        res.status(500).json({ error: 'Tweet request failed' });
    }
});

app.post('/api/linkedin', async (req: Request, res: Response): Promise<void | any> => {
    try {
        const session = req.session as TwitterSession;
        if (!session.linkedin_accessToken) {
            return res.status(401).json({ error: 'Not authenticated for LinkedIn' });
        }

        const accessToken = session.linkedin_accessToken;
        const profileResponse = await fetch(
            "https://api.linkedin.com/v2/me",
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        const profileData = await profileResponse.json() as LinkedInProfileData;
        const personSub = profileData.sub;
        const authorURN = `urn:li:person:${personSub}`;

        const { title, description, url } = req.body as PostRequestBody;

        const payload: LinkedInPostPayload = {
            author: authorURN,
            lifecycleState: "PUBLISHED",
            specificContent: {
                "com.linkedin.ugc.ShareContent": {
                    shareCommentary: {
                        text: title
                    },
                    shareMediaCategory: "ARTICLE",
                    media: [
                        {
                            status: "READY",
                            description: {
                                text: description || '',
                            },
                            originalUrl: url || '',
                            title: {
                                text: title,
                            },
                        },
                    ],
                }
            },
            visibility: {
                "com.linkedin.ugc.MemberNetworkVisibility": "CONNECTIONS"
            }
        };

        console.log('payload ----', payload);

        const postResponse = await fetch('https://api.linkedin.com/v2/ugcPosts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'X-Restli-Protocol-Version': '2.0.0'
            },
            body: JSON.stringify(payload)
        });

        const result = await postResponse.json();

        if (!postResponse.ok) {
            console.error('LinkedIn post error:', result);
            return res.status(postResponse.status).json({ error: result });
        }

        res.json({ success: true, result });
    } catch (error) {
        console.error('LinkedIn posting error:', error);
        res.status(500).json({ error: 'LinkedIn posting error' });
    }
});

// Serve static files
app.use(express.static('public'));

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});