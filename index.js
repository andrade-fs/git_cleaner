import dotenv from 'dotenv';
import simpleGit from "simple-git";


dotenv.config();

const targetUser = process.env.TARGET_USER || 'andrade-fs'
const cutoffDate = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000); // días atrás
const gitPath = process.env.GIT_PATH || undefined
const protectedBranches = ['main', 'dev', 'master', 'version', 'origin/main', 'origin/master', 'origin/dev']; // Agrega las ramas protegidas aquí

const acceptDeleteBranches = process.argv[2]

console.log('targetUser', targetUser)

console.log(acceptDeleteBranches);
if (!gitPath) {
    console.error('Debe especificar la ruta del repositorio.');
    throw new Error('Debe especificar la ruta del repositorio.')
}



const deleteOldBranches = async () => {
    try {
        const git = simpleGit(gitPath);
        const branches = await git.branch(['-r', '--sort=-committerdate']); // Obtener las ramas remotas ordenadas por fecha de commit
        const localBranches = await git.branchLocal(); // Obtener las ramas locales

        if(acceptDeleteBranches && acceptDeleteBranches == '--delete'){
            console.log('A continuación se eliminaran las siguientes ramas:')
        }else {
            console.log('Información sobre las ramas que se eliminaran')
        }
        console.info('-----------------------------------------------------------------------');

        for (const branch of branches.all) {
            const commitDetails = await git.raw(['show', '--no-patch', '--format=%at', branch]); // Obtener la fecha del último commit de la rama
            const commitDate = parseInt(commitDetails.trim()) * 1000; // Convertir la fecha de UNIX timestamp a milisegundos
            const branchAuthor = (await git.raw(['show', '--no-patch', '--format=%an', branch])).trim(); // Obtener el autor del último commit de la rama
            const localBranch = branch.replace('origin/', '');

            if (branchAuthor === targetUser && !protectedBranches.includes(branch) && commitDate < cutoffDate.getTime() && acceptDeleteBranches != '--delete') {
                 console.log(`La rama ${branch}, con fecha de ${new Date(commitDate).toLocaleDateString('es-ES')} perteneciente a ${branchAuthor}`);
            }
            
            if (branchAuthor === targetUser && !protectedBranches.includes(branch) && commitDate < cutoffDate.getTime()  && acceptDeleteBranches == '--delete') {
                if (localBranches.all.includes(localBranch)) {
                    console.log(`Eliminando rama local ${branch}, con fecha de ${new Date(commitDate).toLocaleDateString('es-ES')} perteneciente a ${branchAuthor}`);
                    await git.branch(['-D', localBranch]); // Eliminar la rama local
                }        
                console.log(`Eliminando rama remota ${branch}`);
                await git.push('origin', [':' + localBranch]); // Eliminar la rama remota en origin
            }
        };
        if(!acceptDeleteBranches && acceptDeleteBranches != '--delete'){
            console.info('-----------------------------------------------------------------------');
            console.log('Esto a sido solo informativo si quieres eliminarlas de verdad, ejecuta: ')
            console.info('$ node index.js --delete')
        }
    } catch (error) {
        console.error('ERROR - ', error);
    };
}



if(acceptDeleteBranches && acceptDeleteBranches == '--delete'){
    console.log('Disponde de 11 segundos para cancelar la acción');
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