import axios, { AxiosError } from 'axios';
import { config } from './config';
import { logger, delay } from './utils';

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

function getHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${config.cloudflare.apiToken}`,
        'Content-Type': 'application/json',
    };
}

interface CloudflareZone {
    id: string;
    name: string;
    status: string;
    nameServers: string[];
}

interface CreateZoneResult {
    success: boolean;
    zone?: CloudflareZone;
    errorMessage?: string;
    alreadyExists?: boolean;
}

interface DNSRecord {
    type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX';
    name: string;
    content: string;
    ttl?: number;
    proxied?: boolean;
    priority?: number; // For MX records
}

interface CreateDNSRecordResult {
    success: boolean;
    recordId?: string;
    errorMessage?: string;
}

interface DeleteDNSRecordResult {
    success: boolean;
    errorMessage?: string;
}

/**
 * Create a new zone in Cloudflare
 */
export async function createZone(domain: string): Promise<CreateZoneResult> {
    logger.info(`Creating Cloudflare zone for: ${domain}`);

    try {
        const response = await axios.post(
            `${CLOUDFLARE_API_URL}/zones`,
            {
                name: domain,
                account: { id: config.cloudflare.accountId },
                type: 'full',
            },
            { headers: getHeaders() }
        );

        if (response.data.success) {
            const zone = response.data.result;
            logger.success(`Zone created: ${zone.id}`);
            return {
                success: true,
                zone: {
                    id: zone.id,
                    name: zone.name,
                    status: zone.status,
                    nameServers: zone.name_servers || [],
                },
            };
        }

        return {
            success: false,
            errorMessage: response.data.errors?.map((e: any) => e.message).join(', ') || 'Unknown error',
        };
    } catch (error: any) {
        const axiosError = error as AxiosError<any>;

        // Check if domain already exists
        if (axiosError.response?.status === 409 ||
            axiosError.response?.data?.errors?.some((e: any) => e.code === 1061)) {
            logger.warn(`Zone for ${domain} already exists, fetching existing zone...`);
            return fetchExistingZone(domain);
        }

        const errorMsg = axiosError.response?.data?.errors?.map((e: any) => e.message).join(', ')
            || error.message;
        logger.error(`Cloudflare createZone error: ${errorMsg}`);
        return { success: false, errorMessage: errorMsg };
    }
}

/**
 * Fetch existing zone by domain name
 */
async function fetchExistingZone(domain: string): Promise<CreateZoneResult> {
    try {
        const response = await axios.get(
            `${CLOUDFLARE_API_URL}/zones?name=${domain}&account.id=${config.cloudflare.accountId}`,
            { headers: getHeaders() }
        );

        if (response.data.success && response.data.result.length > 0) {
            const zone = response.data.result[0];
            logger.success(`Found existing zone: ${zone.id}`);
            return {
                success: true,
                alreadyExists: true,
                zone: {
                    id: zone.id,
                    name: zone.name,
                    status: zone.status,
                    nameServers: zone.name_servers || [],
                },
            };
        }

        return { success: false, errorMessage: 'Zone not found' };
    } catch (error: any) {
        logger.error(`Cloudflare fetchExistingZone error: ${error.message}`);
        return { success: false, errorMessage: error.message };
    }
}

/**
 * Create a DNS record in a Cloudflare zone
 */
export async function createDNSRecord(
    zoneId: string,
    record: DNSRecord
): Promise<CreateDNSRecordResult> {
    logger.info(`Creating DNS record: ${record.type} ${record.name} -> ${record.content}`);

    try {
        const response = await axios.post(
            `${CLOUDFLARE_API_URL}/zones/${zoneId}/dns_records`,
            {
                type: record.type,
                name: record.name,
                content: record.content,
                ttl: record.ttl || 1, // 1 = automatic
                proxied: record.proxied ?? false,
                ...(record.priority !== undefined && { priority: record.priority }),
            },
            { headers: getHeaders() }
        );

        if (response.data.success) {
            logger.success(`DNS record created: ${response.data.result.id}`);
            return {
                success: true,
                recordId: response.data.result.id,
            };
        }

        return {
            success: false,
            errorMessage: response.data.errors?.map((e: any) => e.message).join(', ') || 'Unknown error',
        };
    } catch (error: any) {
        const axiosError = error as AxiosError<any>;
        const errorMsg = axiosError.response?.data?.errors?.map((e: any) => e.message).join(', ')
            || error.message;
        logger.error(`Cloudflare createDNSRecord error: ${errorMsg}`);
        return { success: false, errorMessage: errorMsg };
    }
}

/**
 * Create multiple DNS records
 */
export async function createDNSRecords(
    zoneId: string,
    records: DNSRecord[]
): Promise<{ success: boolean; recordIds: string[]; errors: string[] }> {
    const recordIds: string[] = [];
    const errors: string[] = [];

    for (const record of records) {
        const result = await createDNSRecord(zoneId, record);
        if (result.success && result.recordId) {
            recordIds.push(result.recordId);
        } else {
            errors.push(`${record.type} ${record.name}: ${result.errorMessage}`);
        }
    }

    return {
        success: errors.length === 0,
        recordIds,
        errors,
    };
}

/**
 * Delete a DNS record (for rollback)
 */
export async function deleteDNSRecord(
    zoneId: string,
    recordId: string
): Promise<DeleteDNSRecordResult> {
    logger.info(`Deleting DNS record: ${recordId}`);

    try {
        const response = await axios.delete(
            `${CLOUDFLARE_API_URL}/zones/${zoneId}/dns_records/${recordId}`,
            { headers: getHeaders() }
        );

        if (response.data.success) {
            logger.success(`DNS record deleted: ${recordId}`);
            return { success: true };
        }

        return {
            success: false,
            errorMessage: response.data.errors?.map((e: any) => e.message).join(', ') || 'Unknown error',
        };
    } catch (error: any) {
        const axiosError = error as AxiosError<any>;
        const errorMsg = axiosError.response?.data?.errors?.map((e: any) => e.message).join(', ')
            || error.message;
        logger.error(`Cloudflare deleteDNSRecord error: ${errorMsg}`);
        return { success: false, errorMessage: errorMsg };
    }
}

/**
 * Delete multiple DNS records (for rollback)
 */
export async function deleteDNSRecords(zoneId: string, recordIds: string[]): Promise<void> {
    for (const recordId of recordIds) {
        await deleteDNSRecord(zoneId, recordId);
    }
}

/**
 * Check zone status (for NS propagation check)
 */
export async function getZoneStatus(zoneId: string): Promise<{ status: string; nameServers: string[] } | null> {
    try {
        const response = await axios.get(
            `${CLOUDFLARE_API_URL}/zones/${zoneId}`,
            { headers: getHeaders() }
        );

        if (response.data.success) {
            return {
                status: response.data.result.status,
                nameServers: response.data.result.name_servers || [],
            };
        }
        return null;
    } catch (error: any) {
        logger.error(`Cloudflare getZoneStatus error: ${error.message}`);
        return null;
    }
}

/**
 * Poll for zone activation (NS propagation)
 */
export async function waitForZoneActivation(
    zoneId: string,
    maxAttempts: number = 20,
    intervalMs: number = 30000
): Promise<boolean> {
    logger.info(`Waiting for zone ${zoneId} to become active...`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const status = await getZoneStatus(zoneId);

        if (status?.status === 'active') {
            logger.success(`Zone ${zoneId} is now active!`);
            return true;
        }

        logger.info(`Zone status: ${status?.status || 'unknown'} (attempt ${attempt}/${maxAttempts})`);

        if (attempt < maxAttempts) {
            await delay(intervalMs);
        }
    }

    logger.warn(`Zone ${zoneId} did not become active within the timeout period`);
    return false;
}
