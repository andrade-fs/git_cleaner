import dotenv from 'dotenv';
import simpleGit from 'simple-git';
import cliProgress from 'cli-progress';
import inquirer from 'inquirer';

dotenv.config();

const targetUsers = (process.env.TARGET_USERS).split(/[,|]/).map(u => u.trim());
const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago (approx 1 month)
const gitPath = process.env.GIT_PATH || process.cwd();
const protectedBranches = (process.env.PROTECTED_BRANCHES || 'main,dev,master,version,origin/main,origin/master,origin/dev,origin/version').split(/[,|]/).map(b => b.trim());

if (!gitPath) {
    console.error('Debe especificar la ruta del repositorio.');
    throw new Error('Debe especificar la ruta del repositorio.');
}

const git = simpleGit(gitPath);

const getBranches = async () => {
    // Fetch all remote branches
    const branches = await git.branch(['-r', '--sort=-committerdate']);
    const branchDetails = [];

    // Get merged branches to main/master
    // We check both just in case, or we can try to detect default branch. For now assume main/master.
    let mergedBranches = [];
    try {
        const mergedMain = await git.raw(['branch', '-r', '--merged', 'origin/main']);
        mergedBranches = mergedBranches.concat(mergedMain.split('\n').map(b => b.trim()).filter(Boolean));
    } catch (e) {
        // ignore if origin/main doesn't exist
    }
    try {
        const mergedMaster = await git.raw(['branch', '-r', '--merged', 'origin/master']);
        mergedBranches = mergedBranches.concat(mergedMaster.split('\n').map(b => b.trim()).filter(Boolean));
    } catch (e) {
        // ignore
    }

    // De-duplicate merged branches
    const mergedSet = new Set(mergedBranches);

    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    console.log('Analizando ramas...');
    bar.start(branches.all.length, 0);

    for (const branch of branches.all) {
        // Skip HEAD
        if (branch.includes('->')) {
            bar.increment();
            continue;
        }

        const commitDetails = await git.raw(['show', '--no-patch', '--format=%at', branch]);
        const commitDate = parseInt(commitDetails.trim()) * 1000;
        const branchAuthor = (await git.raw(['show', '--no-patch', '--format=%an', branch])).trim();

        branchDetails.push({
            name: branch,
            date: new Date(commitDate),
            author: branchAuthor,
            isMerged: mergedSet.has(branch)
        });
        bar.increment();
    }
    bar.stop();

    return branchDetails;
};


const excludeUsers = (process.env.EXCLUDE_USERS || '').split(/[,|]/).map(u => u.trim()).filter(Boolean);

const filterBranches = (branches, onlyMerged = false) => {
    return branches.filter(branch => {
        let isTargetUser;
        if (excludeUsers.length > 0) {
            isTargetUser = !excludeUsers.includes(branch.author);
        } else {
            isTargetUser = targetUsers.includes(branch.author);
        }

        const isProtected = protectedBranches.some(pb => branch.name === pb || branch.name.endsWith('/' + pb));
        const isOld = branch.date < cutoffDate;

        let matches = isTargetUser && !isProtected && isOld;
        if (onlyMerged) {
            matches = matches && branch.isMerged;
        }
        return matches;
    });
};

const main = async () => {
    try {
        const answers = await inquirer.prompt([
            {
                type: 'list',
                name: 'mode',
                message: '¿Qué desea hacer?',
                choices: [
                    { name: 'Modo Test: Listar ramas a eliminar', value: 'test' },
                    { name: 'Modo Acción: Eliminar ramas', value: 'delete' }
                ]
            },
            {
                type: 'list',
                name: 'filter',
                message: '¿Qué ramas desea incluir?',
                choices: [
                    { name: 'Todas las ramas antiguas (cualquier estado)', value: 'all' },
                    { name: 'Solo ramas mergeadas (ya integradas)', value: 'merged' }
                ]
            }
        ]);

        const allBranches = await getBranches();
        const branchesToDelete = filterBranches(allBranches, answers.filter === 'merged');

        console.log('\n');
        if (branchesToDelete.length === 0) {
            console.log('No se encontraron ramas que cumplan los criterios.');
            return;
        }

        console.info('-----------------------------------------------------------------------');
        if (answers.mode === 'test') {
            console.log('Ramas candidatas a eliminar:');
            branchesToDelete.forEach(b => {
                console.log(`- ${b.name} (${b.date.toLocaleDateString()}) - Autor: ${b.author} [Merged: ${b.isMerged ? 'YES' : 'NO'}]`);
            });
            console.info('-----------------------------------------------------------------------');
            console.log(`Total: ${branchesToDelete.length} ramas.`);
        } else {
            console.log(`Se encontraron ${branchesToDelete.length} ramas para eliminar.`);
            const confirm = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'ESTA ACCIÓN ES DESTRUCTIVA. ¿Está seguro de que desea eliminar estas ramas remotas?',
                    default: false
                }
            ]);

            if (confirm.proceed) {
                const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
                bar.start(branchesToDelete.length, 0);

                let processed = 0;
                for (const branch of branchesToDelete) {
                    const localBranch = branch.name.replace('origin/', '');
                    try {
                        // Delete remote
                        await git.push('origin', [':' + localBranch]);
                        processed++;
                    } catch (err) {
                        console.error(`\nError eliminando ${branch.name}:`, err.message);
                    }
                    bar.update(processed);
                }
                bar.stop();
                console.log('\nProceso finalizado.');
            } else {
                console.log('Operación cancelada.');
            }
        }

    } catch (error) {
        console.error('Error:', error);
    }
};

main();
