import axios, { AxiosError } from 'axios';
import { config } from './config';
import { logger, delay } from './utils';

const VERCEL_API_URL = 'https://api.vercel.com';

function getHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${config.vercel.token}`,
        'Content-Type': 'application/json',
    };
}

function getTeamParam(): string {
    return config.vercel.teamId ? `?teamId=${config.vercel.teamId}` : '';
}

interface VercelDomain {
    name: string;
    verified: boolean;
    verification?: {
        type: string;
        domain: string;
        value: string;
        reason: string;
    }[];
}

interface AddDomainResult {
    success: boolean;
    domain?: VercelDomain;
    errorMessage?: string;
    verificationRequired?: boolean;
    verificationRecords?: Array<{
        type: string;
        name: string;
        value: string;
    }>;
}

interface VerifyDomainResult {
    success: boolean;
    verified: boolean;
    errorMessage?: string;
}

/**
 * Add a domain to a Vercel project
 */
export async function addDomain(domain: string): Promise<AddDomainResult> {
    logger.info(`Adding domain to Vercel project: ${domain}`);

    try {
        const response = await axios.post(
            `${VERCEL_API_URL}/v10/projects/${config.vercel.projectId}/domains${getTeamParam()}`,
            { name: domain },
            { headers: getHeaders() }
        );

        const domainData = response.data;

        // Check if verification is needed
        if (!domainData.verified && domainData.verification) {
            logger.warn(`Domain ${domain} requires verification`);
            return {
                success: true,
                verificationRequired: true,
                domain: {
                    name: domainData.name,
                    verified: domainData.verified,
                    verification: domainData.verification,
                },
                verificationRecords: domainData.verification.map((v: any) => ({
                    type: v.type,
                    name: v.domain,
                    value: v.value,
                })),
            };
        }

        logger.success(`Domain ${domain} added and verified`);
        return {
            success: true,
            domain: {
                name: domainData.name,
                verified: domainData.verified,
            },
        };
    } catch (error: any) {
        const axiosError = error as AxiosError<any>;

        // Domain might already be added
        if (axiosError.response?.status === 409) {
            logger.warn(`Domain ${domain} already exists on project, fetching status...`);
            return getDomainStatus(domain);
        }

        const errorMsg = axiosError.response?.data?.error?.message || error.message;
        logger.error(`Vercel addDomain error: ${errorMsg}`);
        return { success: false, errorMessage: errorMsg };
    }
}

/**
 * Get domain status from Vercel project
 */
async function getDomainStatus(domain: string): Promise<AddDomainResult> {
    try {
        const response = await axios.get(
            `${VERCEL_API_URL}/v9/projects/${config.vercel.projectId}/domains/${domain}${getTeamParam()}`,
            { headers: getHeaders() }
        );

        const domainData = response.data;

        if (!domainData.verified && domainData.verification) {
            return {
                success: true,
                verificationRequired: true,
                domain: {
                    name: domainData.name,
                    verified: domainData.verified,
                    verification: domainData.verification,
                },
                verificationRecords: domainData.verification.map((v: any) => ({
                    type: v.type,
                    name: v.domain,
                    value: v.value,
                })),
            };
        }

        return {
            success: true,
            domain: {
                name: domainData.name,
                verified: domainData.verified,
            },
        };
    } catch (error: any) {
        const axiosError = error as AxiosError<any>;
        const errorMsg = axiosError.response?.data?.error?.message || error.message;
        logger.error(`Vercel getDomainStatus error: ${errorMsg}`);
        return { success: false, errorMessage: errorMsg };
    }
}

/**
 * Verify a domain on Vercel (triggers verification check)
 */
export async function verifyDomain(domain: string): Promise<VerifyDomainResult> {
    logger.info(`Triggering domain verification for: ${domain}`);

    try {
        const response = await axios.post(
            `${VERCEL_API_URL}/v9/projects/${config.vercel.projectId}/domains/${domain}/verify${getTeamParam()}`,
            {},
            { headers: getHeaders() }
        );

        const verified = response.data.verified === true;

        if (verified) {
            logger.success(`Domain ${domain} is now verified!`);
        } else {
            logger.warn(`Domain ${domain} verification pending`);
        }

        return {
            success: true,
            verified,
        };
    } catch (error: any) {
        const axiosError = error as AxiosError<any>;
        const errorMsg = axiosError.response?.data?.error?.message || error.message;
        logger.error(`Vercel verifyDomain error: ${errorMsg}`);
        return { success: false, verified: false, errorMessage: errorMsg };
    }
}

/**
 * Wait for domain verification with retries
 */
export async function waitForDomainVerification(
    domain: string,
    maxAttempts: number = 10,
    intervalMs: number = 30000
): Promise<boolean> {
    logger.info(`Waiting for domain ${domain} to be verified on Vercel...`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await verifyDomain(domain);

        if (result.verified) {
            return true;
        }

        logger.info(`Verification attempt ${attempt}/${maxAttempts} - not yet verified`);

        if (attempt < maxAttempts) {
            await delay(intervalMs);
        }
    }

    logger.error(`Domain ${domain} verification failed after ${maxAttempts} attempts`);
    return false;
}

/**
 * Remove a domain from Vercel project (for rollback)
 */
export async function removeDomain(domain: string): Promise<{ success: boolean; errorMessage?: string }> {
    logger.info(`Removing domain from Vercel project: ${domain}`);

    try {
        await axios.delete(
            `${VERCEL_API_URL}/v9/projects/${config.vercel.projectId}/domains/${domain}${getTeamParam()}`,
            { headers: getHeaders() }
        );

        logger.success(`Domain ${domain} removed from Vercel`);
        return { success: true };
    } catch (error: any) {
        const axiosError = error as AxiosError<any>;
        const errorMsg = axiosError.response?.data?.error?.message || error.message;
        logger.error(`Vercel removeDomain error: ${errorMsg}`);
        return { success: false, errorMessage: errorMsg };
    }
}

/**
 * Get Vercel DNS records needed for domain setup
 * Returns records typically needed: A record for apex, CNAME for www
 */
export function getVercelDNSRecords(domain: string): Array<{ type: 'A' | 'CNAME'; name: string; content: string }> {
    return [
        {
            type: 'A',
            name: '@',
            content: '76.76.21.21', // Vercel's IP
        },
        {
            type: 'CNAME',
            name: 'www',
            content: 'cname.vercel-dns.com',
        },
    ];
}
