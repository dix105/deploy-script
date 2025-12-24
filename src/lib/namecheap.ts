import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { config } from './config';
import { logger } from './utils';

const SANDBOX_URL = 'https://api.sandbox.namecheap.com/xml.response';
const PRODUCTION_URL = 'https://api.namecheap.com/xml.response';

function getBaseUrl(): string {
    return config.environment === 'development' ? SANDBOX_URL : PRODUCTION_URL;
}

function getBaseParams(): Record<string, string> {
    return {
        ApiUser: config.namecheap.apiUser,
        ApiKey: config.namecheap.apiKey,
        UserName: config.namecheap.username,
        ClientIp: config.namecheap.clientIp,
    };
}

interface AvailabilityResult {
    available: boolean;
    domain: string;
    isPremium?: boolean;
    premiumPrice?: string;
    regularPrice?: string;
    errorMessage?: string;
}

interface PurchaseResult {
    success: boolean;
    domainId?: string;
    transactionId?: string;
    orderId?: string;
    chargedAmount?: string;
    errorMessage?: string;
}

interface SetNameserversResult {
    success: boolean;
    errorMessage?: string;
}

/**
 * Check domain availability on Namecheap
 */
export async function checkAvailability(domain: string): Promise<AvailabilityResult> {
    logger.info(`Checking availability for: ${domain}`);

    const params = new URLSearchParams({
        ...getBaseParams(),
        Command: 'namecheap.domains.check',
        DomainList: domain,
    });

    try {
        const response = await axios.get(`${getBaseUrl()}?${params.toString()}`);
        const result = await parseStringPromise(response.data, { explicitArray: false });

        const apiResponse = result.ApiResponse;

        if (apiResponse.$.Status === 'ERROR') {
            const errors = apiResponse.Errors?.Error;
            const errorMsg = Array.isArray(errors)
                ? errors.map((e: any) => e._).join(', ')
                : errors?._ || 'Unknown error';
            return { available: false, domain, errorMessage: errorMsg };
        }

        const domainCheckResult = apiResponse.CommandResponse?.DomainCheckResult;
        if (!domainCheckResult) {
            return { available: false, domain, errorMessage: 'No domain check result returned' };
        }

        const available = domainCheckResult.$.Available === 'true';
        const isPremium = domainCheckResult.$.IsPremiumName === 'true';

        return {
            available,
            domain,
            isPremium,
            premiumPrice: domainCheckResult.$.PremiumRegistrationPrice,
            regularPrice: domainCheckResult.$.RegularPrice,
        };
    } catch (error: any) {
        logger.error(`Namecheap API error: ${error.message}`);
        return { available: false, domain, errorMessage: error.message };
    }
}

interface NamecheapAddress {
    addressId: string;
    addressName: string;
    isDefault: boolean;
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    stateProvince: string;
    postalCode: string;
    country: string;
    phone: string;
    email: string;
}

/**
 * Get list of addresses from Namecheap account
 */
async function getAddressList(): Promise<{ addressId: string; addressName: string; isDefault: boolean }[]> {
    const params = new URLSearchParams({
        ...getBaseParams(),
        Command: 'namecheap.users.address.getList',
    });

    try {
        const response = await axios.get(`${getBaseUrl()}?${params.toString()}`);
        const result = await parseStringPromise(response.data, { explicitArray: false });

        const apiResponse = result.ApiResponse;
        if (apiResponse.$.Status === 'ERROR') {
            logger.error('Failed to get address list');
            return [];
        }

        const addresses = apiResponse.CommandResponse?.AddressGetListResult?.List?.Address;
        if (!addresses) return [];

        const addressList = Array.isArray(addresses) ? addresses : [addresses];
        return addressList.map((addr: any) => ({
            addressId: addr.$.AddressId,
            addressName: addr.$.AddressName,
            isDefault: addr.$.IsDefault === 'true',
        }));
    } catch (error: any) {
        logger.error(`Failed to get address list: ${error.message}`);
        return [];
    }
}

/**
 * Get address details by ID from Namecheap account
 */
async function getAddressInfo(addressId: string): Promise<NamecheapAddress | null> {
    const params = new URLSearchParams({
        ...getBaseParams(),
        Command: 'namecheap.users.address.getInfo',
        AddressId: addressId,
    });

    try {
        const response = await axios.get(`${getBaseUrl()}?${params.toString()}`);
        const result = await parseStringPromise(response.data, { explicitArray: false });

        const apiResponse = result.ApiResponse;
        if (apiResponse.$.Status === 'ERROR') {
            logger.error('Failed to get address info');
            return null;
        }

        const addr = apiResponse.CommandResponse?.GetAddressInfoResult;
        if (!addr) return null;

        return {
            addressId: addr.$.AddressId,
            addressName: addr.$.AddressName || '',
            isDefault: true,
            firstName: addr.FirstName || '',
            lastName: addr.LastName || '',
            address1: addr.Address1 || '',
            address2: addr.Address2 || '',
            city: addr.City || '',
            stateProvince: addr.StateProvince || '',
            postalCode: addr.Zip || '',
            country: addr.Country || '',
            phone: addr.Phone || '',
            email: addr.EmailAddress || '',
        };
    } catch (error: any) {
        logger.error(`Failed to get address info: ${error.message}`);
        return null;
    }
}

/**
 * Get the default address from Namecheap account
 */
async function getDefaultAddress(): Promise<NamecheapAddress | null> {
    const addresses = await getAddressList();
    const defaultAddr = addresses.find(a => a.isDefault);

    if (!defaultAddr) {
        // If no default, use the first address
        if (addresses.length > 0) {
            logger.warn('No default address found, using first address');
            return getAddressInfo(addresses[0].addressId);
        }
        return null;
    }

    return getAddressInfo(defaultAddr.addressId);
}

/**
 * Purchase a domain on Namecheap
 */
export async function purchaseDomain(
    domain: string,
    years: number = 1,
    enableWhoisGuard: boolean = true
): Promise<PurchaseResult> {
    logger.info(`Purchasing domain: ${domain} for ${years} year(s)`);

    const [sld, tld] = splitDomain(domain);

    // Base parameters for the API call
    const baseParams: Record<string, string> = {
        ...getBaseParams(),
        Command: 'namecheap.domains.create',
        DomainName: domain,
        Years: years.toString(),
        AddFreeWhoisguard: enableWhoisGuard ? 'yes' : 'no',
        WGEnabled: enableWhoisGuard ? 'yes' : 'no',
    };

    // Get contact information
    let contactInfo: NamecheapAddress | null = null;

    if (config.namecheap.useDefaultContacts) {
        logger.info('Fetching default contacts from Namecheap account...');
        contactInfo = await getDefaultAddress();

        if (!contactInfo) {
            return {
                success: false,
                errorMessage: 'Could not fetch default address from Namecheap account. Please add an address in your Namecheap dashboard or set NAMECHEAP_USE_DEFAULT_CONTACTS=false and provide REGISTRANT_* fields in .env'
            };
        }
        logger.success(`Using address: ${contactInfo.firstName} ${contactInfo.lastName}`);
    } else {
        // Use manually provided registrant info from .env
        contactInfo = {
            addressId: '',
            addressName: 'env',
            isDefault: true,
            firstName: config.registrant.firstName,
            lastName: config.registrant.lastName,
            address1: config.registrant.address1,
            address2: config.registrant.address2,
            city: config.registrant.city,
            stateProvince: config.registrant.stateProvince,
            postalCode: config.registrant.postalCode,
            country: config.registrant.country,
            phone: config.registrant.phone,
            email: config.registrant.email,
        };
    }

    // Add contact parameters for all roles
    Object.assign(baseParams, {
        // Registrant contact
        RegistrantFirstName: contactInfo.firstName,
        RegistrantLastName: contactInfo.lastName,
        RegistrantAddress1: contactInfo.address1,
        RegistrantCity: contactInfo.city,
        RegistrantStateProvince: contactInfo.stateProvince,
        RegistrantPostalCode: contactInfo.postalCode,
        RegistrantCountry: contactInfo.country,
        RegistrantPhone: contactInfo.phone,
        RegistrantEmailAddress: contactInfo.email,
        // Tech contact (same as registrant)
        TechFirstName: contactInfo.firstName,
        TechLastName: contactInfo.lastName,
        TechAddress1: contactInfo.address1,
        TechCity: contactInfo.city,
        TechStateProvince: contactInfo.stateProvince,
        TechPostalCode: contactInfo.postalCode,
        TechCountry: contactInfo.country,
        TechPhone: contactInfo.phone,
        TechEmailAddress: contactInfo.email,
        // Admin contact (same as registrant)
        AdminFirstName: contactInfo.firstName,
        AdminLastName: contactInfo.lastName,
        AdminAddress1: contactInfo.address1,
        AdminCity: contactInfo.city,
        AdminStateProvince: contactInfo.stateProvince,
        AdminPostalCode: contactInfo.postalCode,
        AdminCountry: contactInfo.country,
        AdminPhone: contactInfo.phone,
        AdminEmailAddress: contactInfo.email,
        // Billing (AuxBilling) contact (same as registrant)
        AuxBillingFirstName: contactInfo.firstName,
        AuxBillingLastName: contactInfo.lastName,
        AuxBillingAddress1: contactInfo.address1,
        AuxBillingCity: contactInfo.city,
        AuxBillingStateProvince: contactInfo.stateProvince,
        AuxBillingPostalCode: contactInfo.postalCode,
        AuxBillingCountry: contactInfo.country,
        AuxBillingPhone: contactInfo.phone,
        AuxBillingEmailAddress: contactInfo.email,
    });

    // Add address2 if provided
    if (contactInfo.address2) {
        baseParams['RegistrantAddress2'] = contactInfo.address2;
        baseParams['TechAddress2'] = contactInfo.address2;
        baseParams['AdminAddress2'] = contactInfo.address2;
        baseParams['AuxBillingAddress2'] = contactInfo.address2;
    }

    const params = new URLSearchParams(baseParams);

    try {
        const response = await axios.get(`${getBaseUrl()}?${params.toString()}`);
        const result = await parseStringPromise(response.data, { explicitArray: false });

        const apiResponse = result.ApiResponse;

        if (apiResponse.$.Status === 'ERROR') {
            const errors = apiResponse.Errors?.Error;
            const errorMsg = Array.isArray(errors)
                ? errors.map((e: any) => e._).join(', ')
                : errors?._ || 'Unknown error';
            return { success: false, errorMessage: errorMsg };
        }

        const domainCreateResult = apiResponse.CommandResponse?.DomainCreateResult;
        if (!domainCreateResult) {
            return { success: false, errorMessage: 'No domain create result returned' };
        }

        return {
            success: domainCreateResult.$.Registered === 'true',
            domainId: domainCreateResult.$.DomainID,
            transactionId: domainCreateResult.$.TransactionID,
            orderId: domainCreateResult.$.OrderID,
            chargedAmount: domainCreateResult.$.ChargedAmount,
        };
    } catch (error: any) {
        logger.error(`Namecheap purchase error: ${error.message}`);
        return { success: false, errorMessage: error.message };
    }
}

/**
 * Set custom nameservers for a domain on Namecheap
 */
export async function setNameservers(
    domain: string,
    nameservers: string[]
): Promise<SetNameserversResult> {
    logger.info(`Setting nameservers for ${domain}: ${nameservers.join(', ')}`);

    const [sld, tld] = splitDomain(domain);

    const params = new URLSearchParams({
        ...getBaseParams(),
        Command: 'namecheap.domains.dns.setCustom',
        SLD: sld,
        TLD: tld,
        Nameservers: nameservers.join(','),
    });

    try {
        const response = await axios.get(`${getBaseUrl()}?${params.toString()}`);
        const result = await parseStringPromise(response.data, { explicitArray: false });

        const apiResponse = result.ApiResponse;

        if (apiResponse.$.Status === 'ERROR') {
            const errors = apiResponse.Errors?.Error;
            const errorMsg = Array.isArray(errors)
                ? errors.map((e: any) => e._).join(', ')
                : errors?._ || 'Unknown error';
            return { success: false, errorMessage: errorMsg };
        }

        const dnsSetResult = apiResponse.CommandResponse?.DomainDNSSetCustomResult;
        return {
            success: dnsSetResult?.$.Update === 'true',
        };
    } catch (error: any) {
        logger.error(`Namecheap setNameservers error: ${error.message}`);
        return { success: false, errorMessage: error.message };
    }
}

/**
 * Split domain into SLD and TLD
 */
function splitDomain(domain: string): [string, string] {
    const parts = domain.split('.');
    if (parts.length < 2) {
        throw new Error(`Invalid domain format: ${domain}`);
    }
    const tld = parts.slice(1).join('.');
    const sld = parts[0];
    return [sld, tld];
}
