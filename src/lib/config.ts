import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function getEnv(key: string, defaultValue?: string): string {
    const value = process.env[key];
    if (!value && defaultValue === undefined) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value || defaultValue || '';
}

export const config = {
    environment: getEnv('ENVIRONMENT', 'development') as 'development' | 'production',

    namecheap: {
        apiUser: getEnv('NAMECHEAP_API_USER', ''),
        apiKey: getEnv('NAMECHEAP_API_KEY', ''),
        username: getEnv('NAMECHEAP_USERNAME', ''),
        clientIp: getEnv('NAMECHEAP_CLIENT_IP', ''),
        useDefaultContacts: getEnv('NAMECHEAP_USE_DEFAULT_CONTACTS', 'true') === 'true',
    },

    cloudflare: {
        apiToken: getEnv('CLOUDFLARE_API_TOKEN', ''),
        accountId: getEnv('CLOUDFLARE_ACCOUNT_ID', ''),
    },

    vercel: {
        token: getEnv('VERCEL_TOKEN', ''),
        projectId: getEnv('VERCEL_PROJECT_ID', ''),
        teamId: getEnv('VERCEL_TEAM_ID', ''),
    },

    github: {
        token: getEnv('GITHUB_TOKEN', ''),
    },

    registrant: {
        firstName: getEnv('REGISTRANT_FIRST_NAME', ''),
        lastName: getEnv('REGISTRANT_LAST_NAME', ''),
        address1: getEnv('REGISTRANT_ADDRESS1', ''),
        address2: getEnv('REGISTRANT_ADDRESS2', ''),
        city: getEnv('REGISTRANT_CITY', ''),
        stateProvince: getEnv('REGISTRANT_STATE_PROVINCE', ''),
        postalCode: getEnv('REGISTRANT_POSTAL_CODE', ''),
        country: getEnv('REGISTRANT_COUNTRY', ''),
        phone: getEnv('REGISTRANT_PHONE', ''),
        email: getEnv('REGISTRANT_EMAIL', ''),
    },
};

/**
 * Validate that all required config for a specific service is present
 */
export function validateConfig(service: 'namecheap' | 'cloudflare' | 'vercel' | 'registrant' | 'github' | 'deploy'): void {
    const requiredFields: Record<string, string[]> = {
        namecheap: ['apiUser', 'apiKey', 'username', 'clientIp'],
        cloudflare: ['apiToken', 'accountId'],
        vercel: ['token', 'projectId'],
        registrant: ['firstName', 'lastName', 'address1', 'city', 'stateProvince', 'postalCode', 'country', 'phone', 'email'],
        github: ['token'],
        deploy: [], // Special: will check both github.token and vercel.token
    };

    // Special handling for deploy which needs both github and vercel tokens
    if (service === 'deploy') {
        if (!config.github.token) {
            throw new Error('Missing required config for deploy: GITHUB_TOKEN');
        }
        if (!config.vercel.token) {
            throw new Error('Missing required config for deploy: VERCEL_TOKEN');
        }
        return;
    }

    const fields = requiredFields[service];
    const serviceConfig = config[service] as Record<string, string>;

    for (const field of fields) {
        if (!serviceConfig[field]) {
            throw new Error(`Missing required ${service} config: ${field}`);
        }
    }
}
