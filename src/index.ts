#!/usr/bin/env node
import { config, validateConfig } from './lib/config';
import { logger, formatDomain, retry } from './lib/utils';
import * as namecheap from './lib/namecheap';
import * as cloudflare from './lib/cloudflare';
import * as vercel from './lib/vercel';
import { deployZipToVercel, setVercelProjectId } from './lib/deploy';

// ============================================================================
// TYPES
// ============================================================================

interface WorkflowState {
    domain: string;
    years: number;
    enableWhoisGuard: boolean;
    // Rollback tracking
    domainPurchased: boolean;
    cloudflareZoneId?: string;
    cloudflareRecordIds: string[];
    vercelDomainAdded: boolean;
}

interface WorkflowResult {
    success: boolean;
    steps: {
        availabilityCheck: boolean;
        domainPurchase: boolean;
        cloudflareZone: boolean;
        nameserversSet: boolean;
        dnsRecords: boolean;
        vercelDomain: boolean;
        vercelVerified: boolean;
    };
    details: {
        domainId?: string;
        transactionId?: string;
        cloudflareZoneId?: string;
        cloudflareNameservers?: string[];
        dnsRecordIds?: string[];
    };
    errors: string[];
}

// ============================================================================
// MAIN WORKFLOW
// ============================================================================

async function runWorkflow(
    domain: string,
    years: number = 1,
    enableWhoisGuard: boolean = true
): Promise<WorkflowResult> {
    const state: WorkflowState = {
        domain,
        years,
        enableWhoisGuard,
        domainPurchased: false,
        cloudflareRecordIds: [],
        vercelDomainAdded: false,
    };

    const result: WorkflowResult = {
        success: false,
        steps: {
            availabilityCheck: false,
            domainPurchase: false,
            cloudflareZone: false,
            nameserversSet: false,
            dnsRecords: false,
            vercelDomain: false,
            vercelVerified: false,
        },
        details: {},
        errors: [],
    };

    try {
        // ========================================================================
        // STEP 1: Check domain availability
        // ========================================================================
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`STEP 1: Checking domain availability for ${formatDomain(domain)}`);
        logger.info('═══════════════════════════════════════════════════════════════');

        validateConfig('namecheap');
        const availabilityResult = await namecheap.checkAvailability(domain);

        if (!availabilityResult.available) {
            const msg = availabilityResult.errorMessage || 'Domain is not available';
            logger.error(`Domain ${domain} is not available: ${msg}`);
            result.errors.push(`Availability: ${msg}`);
            return result;
        }

        logger.success(`Domain ${domain} is available!`);
        if (availabilityResult.isPremium) {
            logger.warn(`This is a premium domain. Price: ${availabilityResult.premiumPrice}`);
        }
        result.steps.availabilityCheck = true;

        // ========================================================================
        // STEP 2: Purchase domain
        // ========================================================================
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`STEP 2: Purchasing domain ${formatDomain(domain)}`);
        logger.info('═══════════════════════════════════════════════════════════════');

        validateConfig('registrant');
        const purchaseResult = await namecheap.purchaseDomain(domain, years, enableWhoisGuard);

        if (!purchaseResult.success) {
            logger.error(`Failed to purchase domain: ${purchaseResult.errorMessage}`);
            result.errors.push(`Purchase: ${purchaseResult.errorMessage}`);
            return result;
        }

        state.domainPurchased = true;
        result.steps.domainPurchase = true;
        result.details.domainId = purchaseResult.domainId;
        result.details.transactionId = purchaseResult.transactionId;
        logger.success(`Domain purchased! ID: ${purchaseResult.domainId}, Amount: ${purchaseResult.chargedAmount}`);

        // ========================================================================
        // STEP 3: Create Cloudflare zone
        // ========================================================================
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`STEP 3: Creating Cloudflare zone for ${formatDomain(domain)}`);
        logger.info('═══════════════════════════════════════════════════════════════');

        validateConfig('cloudflare');
        const zoneResult = await cloudflare.createZone(domain);

        if (!zoneResult.success || !zoneResult.zone) {
            logger.error(`Failed to create Cloudflare zone: ${zoneResult.errorMessage}`);
            result.errors.push(`Cloudflare Zone: ${zoneResult.errorMessage}`);
            await rollback(state);
            return result;
        }

        state.cloudflareZoneId = zoneResult.zone.id;
        result.steps.cloudflareZone = true;
        result.details.cloudflareZoneId = zoneResult.zone.id;
        result.details.cloudflareNameservers = zoneResult.zone.nameServers;
        logger.success(`Cloudflare zone created: ${zoneResult.zone.id}`);
        logger.info(`Nameservers: ${zoneResult.zone.nameServers.join(', ')}`);

        // ========================================================================
        // STEP 4: Set nameservers on Namecheap
        // ========================================================================
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`STEP 4: Setting nameservers on Namecheap`);
        logger.info('═══════════════════════════════════════════════════════════════');

        const nsResult = await retry(
            () => namecheap.setNameservers(domain, zoneResult.zone!.nameServers),
            {
                maxAttempts: 3,
                initialDelayMs: 5000,
                onRetry: (attempt, error) => {
                    logger.warn(`Nameserver update failed (attempt ${attempt}): ${error.message}`);
                },
            }
        );

        if (!nsResult.success) {
            logger.error(`Failed to set nameservers: ${nsResult.errorMessage}`);
            result.errors.push(`Nameservers: ${nsResult.errorMessage}`);
            await rollback(state);
            return result;
        }

        result.steps.nameserversSet = true;
        logger.success('Nameservers updated successfully!');

        // ========================================================================
        // STEP 5: Create DNS records on Cloudflare
        // ========================================================================
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`STEP 5: Creating DNS records for Vercel`);
        logger.info('═══════════════════════════════════════════════════════════════');

        const vercelRecords = vercel.getVercelDNSRecords(domain);
        const dnsResult = await cloudflare.createDNSRecords(
            zoneResult.zone.id,
            vercelRecords.map((r) => ({
                type: r.type,
                name: r.name === '@' ? domain : r.name,
                content: r.content,
                proxied: false,
            }))
        );

        state.cloudflareRecordIds = dnsResult.recordIds;
        result.details.dnsRecordIds = dnsResult.recordIds;

        if (!dnsResult.success) {
            logger.warn(`Some DNS records failed: ${dnsResult.errors.join(', ')}`);
            result.errors.push(...dnsResult.errors);
        } else {
            logger.success(`DNS records created: ${dnsResult.recordIds.join(', ')}`);
        }
        result.steps.dnsRecords = dnsResult.success;

        // ========================================================================
        // STEP 6: Add domain to Vercel
        // ========================================================================
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`STEP 6: Adding domain to Vercel project`);
        logger.info('═══════════════════════════════════════════════════════════════');

        validateConfig('vercel');
        const vercelAddResult = await vercel.addDomain(domain);

        if (!vercelAddResult.success) {
            logger.error(`Failed to add domain to Vercel: ${vercelAddResult.errorMessage}`);
            result.errors.push(`Vercel Add: ${vercelAddResult.errorMessage}`);
            await rollback(state);
            return result;
        }

        state.vercelDomainAdded = true;
        result.steps.vercelDomain = true;
        logger.success('Domain added to Vercel project');

        // Check if additional verification is needed
        if (vercelAddResult.verificationRequired && vercelAddResult.verificationRecords) {
            logger.warn('Domain requires verification. Creating verification TXT records...');

            // Create verification TXT records
            for (const record of vercelAddResult.verificationRecords) {
                if (record.type === 'TXT') {
                    const txtResult = await cloudflare.createDNSRecord(zoneResult.zone.id, {
                        type: 'TXT',
                        name: record.name,
                        content: record.value,
                    });
                    if (txtResult.success && txtResult.recordId) {
                        state.cloudflareRecordIds.push(txtResult.recordId);
                    }
                }
            }
        }

        // ========================================================================
        // STEP 7: Verify domain on Vercel
        // ========================================================================
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`STEP 7: Verifying domain on Vercel`);
        logger.info('═══════════════════════════════════════════════════════════════');

        const verified = await vercel.waitForDomainVerification(domain, 10, 30000);

        if (!verified) {
            logger.error('Domain verification failed after 10 attempts');
            result.errors.push('Vercel Verification: Failed after 10 attempts - requires manual review');
            // Don't rollback, just mark as failed verification
        } else {
            result.steps.vercelVerified = true;
            logger.success('Domain verified on Vercel!');
        }

        // ========================================================================
        // COMPLETE
        // ========================================================================
        result.success = Object.values(result.steps).every((step) => step === true);

        if (result.success) {
            logger.info('═══════════════════════════════════════════════════════════════');
            logger.success('🎉 WORKFLOW COMPLETED SUCCESSFULLY!');
            logger.info('═══════════════════════════════════════════════════════════════');
            logger.info(`Domain: ${formatDomain(domain)}`);
            logger.info(`Cloudflare Zone ID: ${result.details.cloudflareZoneId}`);
            logger.info(`Nameservers: ${result.details.cloudflareNameservers?.join(', ')}`);
        } else {
            logger.warn('Workflow completed with some steps failing');
        }

        return result;
    } catch (error: any) {
        logger.error(`Unexpected error: ${error.message}`);
        result.errors.push(`Unexpected: ${error.message}`);
        await rollback(state);
        return result;
    }
}

// ============================================================================
// ROLLBACK
// ============================================================================

async function rollback(state: WorkflowState): Promise<void> {
    logger.warn('═══════════════════════════════════════════════════════════════');
    logger.warn('INITIATING ROLLBACK...');
    logger.warn('═══════════════════════════════════════════════════════════════');

    // Remove domain from Vercel
    if (state.vercelDomainAdded) {
        try {
            await vercel.removeDomain(state.domain);
            logger.info('Removed domain from Vercel');
        } catch (e: any) {
            logger.error(`Failed to remove domain from Vercel: ${e.message}`);
        }
    }

    // Delete DNS records
    if (state.cloudflareZoneId && state.cloudflareRecordIds.length > 0) {
        try {
            await cloudflare.deleteDNSRecords(state.cloudflareZoneId, state.cloudflareRecordIds);
            logger.info('Deleted DNS records from Cloudflare');
        } catch (e: any) {
            logger.error(`Failed to delete DNS records: ${e.message}`);
        }
    }

    // Note: We cannot un-purchase a domain, so we just log it
    if (state.domainPurchased) {
        logger.warn(
            `⚠️  Domain ${state.domain} was purchased and CANNOT be automatically refunded. ` +
            `Please contact Namecheap support if needed.`
        );
    }

    logger.info('Rollback completed');
}

// ============================================================================
// INDIVIDUAL OPERATIONS (for CLI flexibility)
// ============================================================================

export async function checkDomainAvailability(domain: string): Promise<void> {
    validateConfig('namecheap');
    const result = await namecheap.checkAvailability(domain);

    if (result.errorMessage) {
        logger.error(`Error: ${result.errorMessage}`);
        return;
    }

    if (result.available) {
        logger.success(`✅ ${domain} is AVAILABLE`);
        if (result.isPremium) {
            logger.info(`   Premium price: ${result.premiumPrice}`);
        }
    } else {
        logger.warn(`❌ ${domain} is NOT AVAILABLE`);
    }
}

// ============================================================================
// WORKFLOW WITH DEPLOY - Deploy first, then add domain
// ============================================================================

async function runWorkflowWithDeploy(
    zipPath: string,
    domain: string,
    years: number = 1,
    enableWhoisGuard: boolean = true
): Promise<WorkflowResult & { deploymentUrl?: string }> {
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('STARTING FULL DEPLOY + DOMAIN WORKFLOW');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`ZIP: ${zipPath}`);
    logger.info(`Domain: ${formatDomain(domain)}`);
    logger.info('');

    // Step 0: Deploy to GitHub + Vercel first
    validateConfig('deploy');
    const deployResult = await deployZipToVercel(zipPath, domain.replace(/\./g, '-'));

    if (!deployResult.success) {
        logger.error(`Deployment failed: ${deployResult.errorMessage}`);
        return {
            success: false,
            steps: {
                availabilityCheck: false,
                domainPurchase: false,
                cloudflareZone: false,
                nameserversSet: false,
                dnsRecords: false,
                vercelDomain: false,
                vercelVerified: false,
            },
            details: {},
            errors: [`Deploy: ${deployResult.errorMessage}`],
        };
    }

    // Update the Vercel project ID to use the newly created project
    if (deployResult.vercelProjectId) {
        setVercelProjectId(deployResult.vercelProjectId);
        logger.success(`Using Vercel project: ${deployResult.vercelProjectId}`);
    }

    // Now run the domain workflow
    const workflowResult = await runWorkflow(domain, years, enableWhoisGuard);

    return {
        ...workflowResult,
        deploymentUrl: deployResult.deploymentUrl,
    };
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];
    const arg1 = args[1];
    const arg2 = args[2];

    logger.info(`Environment: ${config.environment.toUpperCase()}`);
    logger.info('');

    if (!command) {
        printUsage();
        return;
    }

    switch (command) {
        case 'check':
            if (!arg1) {
                logger.error('Please provide a domain: npx ts-node src/index.ts check example.com');
                return;
            }
            await checkDomainAvailability(arg1);
            break;

        case 'run':
            if (!arg1) {
                logger.error('Please provide a domain: npx ts-node src/index.ts run example.com');
                return;
            }
            const years = parseInt(arg2 || '1', 10);
            await runWorkflow(arg1, years);
            break;

        case 'deploy':
            if (!arg1) {
                logger.error('Please provide a ZIP path: npx ts-node src/index.ts deploy ./site.zip');
                return;
            }
            validateConfig('deploy');
            const deployResult = await deployZipToVercel(arg1, arg2);
            if (deployResult.success) {
                logger.info('');
                logger.info('To add a domain to this project, run:');
                logger.info(`  npx ts-node src/index.ts run <domain> --project-id=${deployResult.vercelProjectId}`);
            }
            break;

        case 'deploy-with-domain':
            if (!arg1 || !arg2) {
                logger.error('Please provide ZIP path and domain: npx ts-node src/index.ts deploy-with-domain ./site.zip example.com');
                return;
            }
            const domainYears = parseInt(args[3] || '1', 10);
            await runWorkflowWithDeploy(arg1, arg2, domainYears);
            break;

        case 'help':
        default:
            printUsage();
            break;
    }
}

function printUsage(): void {
    console.log(`
Domain Management Script
========================

Usage:
  npx ts-node src/index.ts <command> [options]

Commands:
  check <domain>                           Check if a domain is available
  run <domain> [years]                     Run the full workflow (check, purchase, configure)
  deploy <zip-path> [project-name]         Deploy a ZIP file to GitHub + Vercel
  deploy-with-domain <zip-path> <domain>   Deploy ZIP + purchase domain + configure DNS
  help                                     Show this help message

Examples:
  npx ts-node src/index.ts check example.com
  npx ts-node src/index.ts run example.com 1
  npx ts-node src/index.ts deploy ./generated_site.zip my-project
  npx ts-node src/index.ts deploy-with-domain ./site.zip example.com 1

Environment:
  Set ENVIRONMENT=development for Namecheap Sandbox
  Set ENVIRONMENT=production for live Namecheap API

  Copy .env.example to .env and fill in your API credentials.
`);
}

main().catch((error) => {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
});
