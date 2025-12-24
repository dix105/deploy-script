import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { glob } from 'glob';
import { config } from './config';
import { logger } from './utils';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

interface DeployResult {
    success: boolean;
    vercelProjectId?: string;
    vercelProjectName?: string;
    deploymentUrl?: string;
    githubRepoUrl?: string;
    errorMessage?: string;
}

interface GitHubRepoResult {
    success: boolean;
    repoName?: string;
    repoUrl?: string;
    username?: string;
    errorMessage?: string;
}

/**
 * Extract ZIP file to a directory
 */
function extractZip(zipPath: string, extractDir: string): string {
    logger.info(`Extracting ZIP: ${zipPath}`);

    if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true });
    }

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);

    // Check if extraction resulted in a single subfolder and use that as root
    let actualExtractDir = extractDir;
    const extractedItems = fs.readdirSync(extractDir);
    if (extractedItems.length === 1) {
        const singleItem = path.join(extractDir, extractedItems[0]);
        if (fs.statSync(singleItem).isDirectory()) {
            actualExtractDir = singleItem;
            logger.info(`Detected nested folder, using: ${actualExtractDir}`);
        }
    }

    logger.success(`Extracted to: ${actualExtractDir}`);
    return actualExtractDir;
}

/**
 * Get GitHub username from token
 */
async function getGitHubUsername(): Promise<string> {
    if (!GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN is not set');
    }

    const response = await axios.get('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
    });

    return response.data.login;
}

/**
 * Create a GitHub repository and upload files
 */
async function createGitHubRepo(
    extractDir: string,
    repoName?: string
): Promise<GitHubRepoResult> {
    if (!GITHUB_TOKEN) {
        return { success: false, errorMessage: 'GITHUB_TOKEN is not set' };
    }

    try {
        const username = await getGitHubUsername();
        const finalRepoName = repoName || `site-deploy-${Date.now()}`;

        logger.info(`Creating GitHub repo: ${finalRepoName}`);

        // Create the repository
        await axios.post(
            'https://api.github.com/user/repos',
            { name: finalRepoName, private: false, auto_init: false },
            { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
        );

        // Get all files
        const files = await glob('**/*', {
            cwd: extractDir,
            nodir: true,
            dot: true,
            ignore: ['**/.git/**', '.git/**'],
        });

        logger.info(`Uploading ${files.length} files to GitHub...`);

        // Upload files
        for (const file of files) {
            const filePath = path.join(extractDir, file);
            const content = fs.readFileSync(filePath);
            const base64Content = content.toString('base64');

            await axios.put(
                `https://api.github.com/repos/${username}/${finalRepoName}/contents/${file}`,
                {
                    message: `Add ${file}`,
                    content: base64Content,
                },
                { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
            );
            logger.info(`  Uploaded: ${file}`);
        }

        logger.success('All files uploaded to GitHub');

        return {
            success: true,
            repoName: finalRepoName,
            repoUrl: `https://github.com/${username}/${finalRepoName}`,
            username,
        };
    } catch (error: any) {
        const errorMsg = error.response?.data?.message || error.message;
        logger.error(`GitHub upload failed: ${errorMsg}`);
        return { success: false, errorMessage: errorMsg };
    }
}

/**
 * Deploy to Vercel from GitHub or with direct file upload
 */
async function deployToVercel(
    extractDir: string,
    projectName: string,
    githubUsername?: string,
    githubRepoName?: string
): Promise<DeployResult> {
    const vercelToken = config.vercel.token;
    if (!vercelToken) {
        return { success: false, errorMessage: 'VERCEL_TOKEN is not set' };
    }

    const teamParam = config.vercel.teamId ? `?teamId=${config.vercel.teamId}` : '';

    try {
        let deploymentUrl: string = '';
        let projectId: string = '';

        // Try GitHub-linked deployment first
        if (githubUsername && githubRepoName) {
            logger.info('Attempting GitHub-linked deployment...');
            try {
                const createProjectRes = await axios.post(
                    `https://api.vercel.com/v10/projects${teamParam}`,
                    {
                        name: projectName,
                        framework: null,
                        gitRepository: {
                            type: 'github',
                            repo: `${githubUsername}/${githubRepoName}`,
                        },
                    },
                    { headers: { Authorization: `Bearer ${vercelToken}` } }
                );

                projectId = createProjectRes.data.id;
                logger.success(`Vercel project created with GitHub link, ID: ${projectId}`);

                // Wait for Vercel to process the connection
                await new Promise((r) => setTimeout(r, 3000));

                // Trigger deployment from GitHub
                const deployRes = await axios.post(
                    `https://api.vercel.com/v13/deployments${teamParam}`,
                    {
                        name: projectName,
                        gitSource: {
                            type: 'github',
                            org: githubUsername,
                            repo: githubRepoName,
                            ref: 'main',
                        },
                        target: 'production',
                    },
                    { headers: { Authorization: `Bearer ${vercelToken}` } }
                );

                deploymentUrl = deployRes.data.url;
                logger.success(`GitHub deployment triggered: ${deploymentUrl}`);

                return {
                    success: true,
                    vercelProjectId: projectId,
                    vercelProjectName: projectName,
                    deploymentUrl,
                    githubRepoUrl: `https://github.com/${githubUsername}/${githubRepoName}`,
                };
            } catch (err: any) {
                logger.warn('GitHub integration not available, using file-based deployment...');
                logger.info(`  Reason: ${err.response?.data?.error?.message || err.message}`);
            }
        }

        // Fall back to file-based deployment
        const files = await glob('**/*', {
            cwd: extractDir,
            nodir: true,
            dot: true,
            ignore: ['**/.git/**', '.git/**'],
        });

        // Prepare files with SHA1 digests
        const vercelFiles: { file: string; sha: string; size: number }[] = [];
        for (const file of files) {
            const filePath = path.join(extractDir, file);
            const content = fs.readFileSync(filePath);
            const sha = crypto.createHash('sha1').update(content).digest('hex');
            vercelFiles.push({ file, sha, size: content.length });
        }

        // Upload files to Vercel
        logger.info(`Uploading ${vercelFiles.length} files to Vercel...`);
        for (const fileInfo of vercelFiles) {
            const filePath = path.join(extractDir, fileInfo.file);
            const content = fs.readFileSync(filePath);

            try {
                await axios.post(
                    `https://api.vercel.com/v2/files${teamParam}`,
                    content,
                    {
                        headers: {
                            Authorization: `Bearer ${vercelToken}`,
                            'Content-Type': 'application/octet-stream',
                            'x-vercel-digest': fileInfo.sha,
                        },
                    }
                );
                logger.info(`  Uploaded: ${fileInfo.file}`);
            } catch (uploadErr: any) {
                if (uploadErr.response?.status !== 409) {
                    logger.error(`  Error uploading ${fileInfo.file}: ${uploadErr.response?.data || uploadErr.message}`);
                } else {
                    logger.info(`  Already exists: ${fileInfo.file}`);
                }
            }
        }

        // Create the deployment
        logger.info('Creating deployment...');
        const deployRes = await axios.post(
            `https://api.vercel.com/v13/deployments${teamParam}`,
            {
                name: projectName,
                files: vercelFiles,
                projectSettings: { framework: null },
                target: 'production',
            },
            { headers: { Authorization: `Bearer ${vercelToken}` } }
        );

        deploymentUrl = deployRes.data.url;
        projectId = deployRes.data.projectId || projectName;
        logger.success(`Deployment created: ${deploymentUrl}`);

        return {
            success: true,
            vercelProjectId: projectId,
            vercelProjectName: projectName,
            deploymentUrl,
        };
    } catch (error: any) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        logger.error(`Vercel deployment failed: ${errorMsg}`);
        return { success: false, errorMessage: errorMsg };
    }
}

/**
 * Wait for Vercel deployment to be ready
 */
async function waitForDeployment(
    deploymentUrl: string,
    maxAttempts: number = 60,
    intervalMs: number = 5000
): Promise<{ ready: boolean; finalUrl: string }> {
    logger.info('Waiting for deployment to be ready...');

    const vercelToken = config.vercel.token;
    const teamParam = config.vercel.teamId ? `?teamId=${config.vercel.teamId}` : '';

    for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, intervalMs));

        try {
            const statusRes = await axios.get(
                `https://api.vercel.com/v13/deployments/${deploymentUrl}${teamParam}`,
                { headers: { Authorization: `Bearer ${vercelToken}` } }
            );

            const state = statusRes.data.readyState;
            logger.info(`  Deployment state: ${state}`);

            if (state === 'READY') {
                const finalUrl = statusRes.data.url || deploymentUrl;
                return { ready: true, finalUrl };
            } else if (state === 'ERROR' || state === 'CANCELED') {
                logger.error(`Deployment failed with state: ${state}`);
                return { ready: false, finalUrl: deploymentUrl };
            }
        } catch (err) {
            // Ignore and retry
        }
    }

    logger.error('Deployment timed out');
    return { ready: false, finalUrl: deploymentUrl };
}

/**
 * Main deploy function - deploys ZIP to GitHub + Vercel and returns project ID
 */
export async function deployZipToVercel(
    zipPath: string,
    projectName?: string
): Promise<DeployResult> {
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('DEPLOYING ZIP TO GITHUB + VERCEL');
    logger.info('═══════════════════════════════════════════════════════════════');

    // Validate
    if (!fs.existsSync(zipPath)) {
        return { success: false, errorMessage: `ZIP file not found: ${zipPath}` };
    }

    if (!GITHUB_TOKEN) {
        return { success: false, errorMessage: 'GITHUB_TOKEN must be set in .env' };
    }

    if (!config.vercel.token) {
        return { success: false, errorMessage: 'VERCEL_TOKEN must be set in .env' };
    }

    const extractDir = path.join(path.dirname(zipPath), 'extracted');
    const finalProjectName = projectName || `site-deploy-${Date.now()}`;

    try {
        // 1. Extract ZIP
        const actualExtractDir = extractZip(zipPath, extractDir);

        // 2. Create GitHub repo
        const githubResult = await createGitHubRepo(actualExtractDir, finalProjectName);
        if (!githubResult.success) {
            return { success: false, errorMessage: githubResult.errorMessage };
        }

        // 3. Deploy to Vercel
        const vercelResult = await deployToVercel(
            actualExtractDir,
            finalProjectName,
            githubResult.username,
            githubResult.repoName
        );

        if (!vercelResult.success) {
            return vercelResult;
        }

        // 4. Wait for deployment
        if (vercelResult.deploymentUrl) {
            const { ready, finalUrl } = await waitForDeployment(vercelResult.deploymentUrl);
            if (ready) {
                vercelResult.deploymentUrl = finalUrl;
            }
        }

        logger.success('═══════════════════════════════════════════════════════════════');
        logger.success('🚀 DEPLOYMENT SUCCESSFUL!');
        logger.info(`   GitHub: ${vercelResult.githubRepoUrl}`);
        logger.info(`   Vercel Project ID: ${vercelResult.vercelProjectId}`);
        logger.info(`   URL: https://${vercelResult.deploymentUrl}`);
        logger.success('═══════════════════════════════════════════════════════════════');

        return vercelResult;
    } finally {
        // Cleanup extracted directory
        if (fs.existsSync(extractDir)) {
            fs.rmSync(extractDir, { recursive: true });
        }
    }
}

/**
 * Export utility to update the Vercel project ID after deployment
 */
export function setVercelProjectId(projectId: string): void {
    // This updates the runtime config (not the .env file)
    (config.vercel as any).projectId = projectId;
    logger.info(`Vercel project ID set to: ${projectId}`);
}
