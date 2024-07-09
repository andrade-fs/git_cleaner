import dotenv from 'dotenv';
import simpleGit from 'simple-git';
import cliProgress from 'cli-progress';

dotenv.config();

const targetUsers = (process.env.TARGET_USERS || 'andrade-fs').split(','); // Convertir la lista de usuarios en un array
const cutoffDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // días atrás
const gitPath = process.env.GIT_PATH || undefined;
const protectedBranches = ['main', 'dev', 'master', 'version', 'origin/main', 'origin/master', 'origin/dev']; // Agrega las ramas protegidas aquí
console.log('cutoffDate', cutoffDate);
const acceptDeleteBranches = process.argv[2];

console.log('targetUsers:', targetUsers);

if (!gitPath) {
    console.error('Debe especificar la ruta del repositorio.');
    throw new Error('Debe especificar la ruta del repositorio.');
}

const deleteOldBranches = async () => {
    try {
        const git = simpleGit(gitPath);
        const branches = await git.branch(['-r', '--sort=-committerdate']); // Obtener las ramas remotas ordenadas por fecha de commit
        const localBranches = await git.branchLocal(); // Obtener las ramas locales

        const branchesToDelete = [];
        for (const branch of branches.all) {
            const commitDetails = await git.raw(['show', '--no-patch', '--format=%at', branch]); // Obtener la fecha del último commit de la rama
            const commitDate = parseInt(commitDetails.trim()) * 1000; // Convertir la fecha de UNIX timestamp a milisegundos
            const branchAuthor = (await git.raw(['show', '--no-patch', '--format=%an', branch])).trim(); // Obtener el autor del último commit de la rama

            if (targetUsers.includes(branchAuthor) && !protectedBranches.includes(branch) && commitDate < cutoffDate.getTime()) {
                branchesToDelete.push(branch);
            }
        }

        if (acceptDeleteBranches && acceptDeleteBranches === '--delete') {
            console.log('A continuación se eliminarán las siguientes ramas:');
        } else {
            console.log('Información sobre las ramas que se eliminarán:');
        }
        console.info('-----------------------------------------------------------------------');

        if (acceptDeleteBranches === '--delete') {
            const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
            bar.start(branchesToDelete.length, 0);
        }

        let processedBranches = 0;
        for (const branch of branchesToDelete) {
            const commitDetails = await git.raw(['show', '--no-patch', '--format=%at', branch]);
            const commitDate = parseInt(commitDetails.trim()) * 1000;
            const branchAuthor = (await git.raw(['show', '--no-patch', '--format=%an', branch])).trim();
            const localBranch = branch.replace('origin/', '');

            if (acceptDeleteBranches !== '--delete') {
                console.log(`La rama ${branch}, con fecha de ${new Date(commitDate).toLocaleDateString('es-ES')} perteneciente a ${branchAuthor}`);
            } else {
                // if (localBranches.all.includes(localBranch)) {
                //     console.log(`Eliminando rama local ${branch}, con fecha de ${new Date(commitDate).toLocaleDateString('es-ES')} perteneciente a ${branchAuthor}`);
                //     await git.branch(['-D', localBranch]); // Eliminar la rama local
                // }
                console.log(`Eliminando rama remota ${branch}`);
                await git.push('origin', [':' + localBranch]); // Eliminar la rama remota en origin
                processedBranches++;
                bar.update(processedBranches);
            }
        }

        bar.stop();

        if (acceptDeleteBranches !== '--delete') {
            console.info('-----------------------------------------------------------------------');
            console.log('Esto ha sido solo informativo. Si quieres eliminarlas de verdad, ejecuta:');
            console.info('$ node index.js --delete');
        }
    } catch (error) {
        console.error('ERROR - ', error);
    }
};

if (acceptDeleteBranches && acceptDeleteBranches === '--delete') {
    console.log('Dispone de 11 segundos para cancelar la acción');
    const cancelTimeout = setTimeout(() => {
        deleteOldBranches();
    }, 11000);

    process.stdin.on('data', (data) => {
        const input = data.toString().trim().toLowerCase();

        if (input === '') {
            clearTimeout(cancelTimeout);
            console.log('Operación cancelada por el usuario.');
            process.exit(0);
        }
    });

    console.log('Presione "Enter" para cancelar la operación...');
} else {
    deleteOldBranches();
}
