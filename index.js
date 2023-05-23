const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { lookup } = require('mime-types');

const { getInput, setFailed } = require('@actions/core');
const { BlobServiceClient } = require('@azure/storage-blob');

async function* listFiles(rootFolder){

    const readdir = promisify(fs.readdir);

    const listFilesAsync = async function* (parentFolder){
        const statSync = fs.statSync(parentFolder);
        if(statSync.isFile()){
            yield parentFolder;
        }
        else if (statSync.isDirectory()){
            const files = await readdir(parentFolder); 
            for (const file of files){
                const fileName = path.join(parentFolder, file);
                yield *listFilesAsync(fileName);
            }
        }
    }

    yield *listFilesAsync(rootFolder);
}

async function uploadFileToBlob(containerService, fileName, blobName){

    var blobClient = containerService.getBlockBlobClient(blobName);
    var blobContentType = lookup(fileName) || 'application/octet-stream';
    await blobClient.uploadFile(fileName, { blobHTTPHeaders: { blobContentType } });

    console.log(`The file ${fileName} was uploaded as ${blobName}, with the content-type of ${blobContentType}`);
}

function checkSubfolderExclusion(folderName, target, blob) {
    if(folderName.indexOf(',') >= 0) {
        var exclusionFlag = false;
        var folderNameArray = folderName.split(',').map(function(value) {
            return value.trim();
        });

        folderNameArray.forEach(theFolderName => {
            if(blob.name.startsWith(target + `${theFolderName}/`)){
                exclusionFlag = true;
            }
        });
        return exclusionFlag;
    } else {
        return blob.name.startsWith(target + `${folderName}/`);
    }
}

function millisToMinutesAndSeconds(millis) {
    var minutes = Math.floor(millis / 60000);
    var seconds = ((millis % 60000) / 1000).toFixed(0);
    return minutes + "m " + (seconds < 10 ? '0' : '') + seconds + "s";
}

async function copyBlob(
    containerService, 
    sourceBlobContainerName, 
    sourceBlobName, 
    destinationBlobContainerName,
    destinationBlobName) {

    // create container clients
    const sourceContainerClient = containerService.getContainerClient(sourceBlobContainerName); 
    const destinationContainerClient = containerService.getContainerClient(destinationBlobContainerName);   
    
    // create blob clients
    const sourceBlobClient = await sourceContainerClient.getBlobClient(sourceBlobName);
    const destinationBlobClient = await destinationContainerClient.getBlobClient(destinationBlobName);

    // start copy
    const copyPoller = await destinationBlobClient.beginCopyFromURL(sourceBlobClient.url);

    console.log(`copying file ${sourceBlobName} to ${destinationBlobName}`);
    // wait until done
    await copyPoller.pollUntilDone();
}

const main = async () => {
    let UID = (new Date().valueOf()).toString();
    let uploadStart;
    let uploadEnd; 
    let copySubFolderStart;
    let copySubFolderEnd; 
    let deleteTargetStart;
    let deleteTargetEnd;
    let copyStart;
    let copyEnd; 
    let deleteTempStart;
    let deleteTempEnd; 
    
    const connectionString = getInput('connection-string');
    if (!connectionString) {
        throw "Connection string must be specified!";
    }

    const enableStaticWebSite = getInput('enabled-static-website');
    const containerName = (enableStaticWebSite) ? "$web" : getInput('blob-container-name') ;
    if (!containerName) {
        throw "Either specify a container name, or set enableStaticWebSite to true!";
    }

    const source = getInput('source');
    let target = getInput('target');
    if (target.startsWith('/')) target = target.slice(1);
    let targetUID = '/';
    console.log(`target ${target}`)
    if(target !== '/') {
        // go up one level of path prefix unless it's at root already
        console.log('target up')
        targetUID = path.join(target, '..', UID);
    } else if(!target){
        console.log('wat')
        targetUID = path.join('$web', UID);
    }

    if(!target) {
        console.log('uh ok')
    }
    const accessPolicy = getInput('public-access-policy');
    const indexFile = getInput('index-file') || 'index.html';
    const errorFile = getInput('error-file');
    const removeExistingFiles = getInput('remove-existing-files');
    const excludeSubfolder = getInput('exclude-subfolder');

    const blobServiceClient = await BlobServiceClient.fromConnectionString(connectionString);

    if (enableStaticWebSite) {
        var props = await blobServiceClient.getProperties();

        props.cors = props.cors || [];
        props.staticWebsite.enabled = true;
        if(!!indexFile){
            props.staticWebsite.indexDocument = indexFile;
        }
        if(!!errorFile){
            props.staticWebsite.errorDocument404Path = errorFile;
        }
        await blobServiceClient.setProperties(props);
    }

    console.log(`containerName ${containerName}`)
    const containerService = blobServiceClient.getContainerClient(containerName);
    if (!await containerService.exists()) {
        await containerService.create({ access: accessPolicy });
    }
    else {
        await containerService.setAccessPolicy(accessPolicy);
    }

    const rootFolder = path.resolve(source);

    console.log(`containerName ${containerName}`)
    console.log(`source ${source}`)
    console.log(`target ${target}`)
    console.log(`rootFolder ${rootFolder}`)

    console.log('uploading')
    if(fs.statSync(rootFolder).isFile()){
        // when does this ever get called in the case of AdobeDocs?
        // seems to be if the pathPrefix is a file location then this uploads to that???
        return await uploadFileToBlob(containerService, rootFolder, path.join(target, path.basename(rootFolder)));
    }
    else{
        uploadStart = new Date();
        console.log('starting upload')
        for await (const fileName of listFiles(rootFolder)) {
            var blobName = path.relative(rootFolder, fileName);
            await uploadFileToBlob(containerService, fileName, path.join(targetUID, blobName));
        }
        uploadEnd = new Date();
    }

    console.log('copying')
    copySubFolderStart = new Date();
    // move over excluded subfolders to temp location too
    for await (const blob of containerService.listBlobsFlat({prefix: target})) {
        // make sure to get the excludeSubfolder and copy it
        if (excludeSubfolder !== '' && checkSubfolderExclusion(excludeSubfolder, target, blob)) {
            // get the split after target so we can just copy over just the excluded subfolders 
            let blobNameSplit =  blob.name.split(target)[1];
            console.log(`The file ${blob.name} is copying to ${path.join(targetUID, blobNameSplit)}`);

            await copyBlob(blobServiceClient, containerName, blob.name, containerName, path.join(targetUID, blobNameSplit));
        } 
    }
    copySubFolderEnd= new Date();

    deleteTargetStart = new Date();

    console.log('deleting og')
    // delete original target folder
    if (!target) {
        // kinda unclear when this fires
        for await (const blob of containerService.listBlobsFlat()){
            await containerService.deleteBlob(blob.name);
        }
    }
    else {
        for await (const blob of containerService.listBlobsFlat({prefix: target})){
            if (blob.name.startsWith(target)) {
                console.log(`The file ${blob.name} is set for deletion`);
                await containerService.deleteBlob(blob.name);
            }
        }
    }
    deleteTargetEnd = new Date();

    copyStart = new Date();
    console.log('copy temp folder')
    // copy temp foldr back to target
    for await (const blob of containerService.listBlobsFlat({prefix: targetUID})){
        // get the split after targetUID
        let blobNameTargetUIDSplit =  blob.name.split(targetUID)[1];
        await copyBlob(blobServiceClient, containerName, blob.name, containerName, path.join(target, blobNameTargetUIDSplit));
    }
    copyEnd = new Date();

    deleteTempStart = new Date();
    console.log('delete temp')
    // delete temp folder
    for await (const blob of containerService.listBlobsFlat({prefix: targetUID})){
        if (blob.name.startsWith(targetUID)) {
            console.log(`The file ${blob.name} is set for deletion`);
            await containerService.deleteBlob(blob.name);
        }
    }
    deleteTempEnd = new Date();

    // millisToMinutesAndSeconds
    console.log(`Upload took: ${millisToMinutesAndSeconds(uploadEnd - uploadStart)}`);
    console.log(`Copy subfolder took: ${millisToMinutesAndSeconds(copySubFolderEnd - copySubFolderStart)}`);
    console.log(`Deletion of original target folder took: ${millisToMinutesAndSeconds(deleteTargetEnd - deleteTargetStart)}`);
    console.log(`Copy from temp to target folder took: ${millisToMinutesAndSeconds(copyEnd - copyStart)}`);
    console.log(`Deletion of temp folder took: ${millisToMinutesAndSeconds(deleteTempEnd - deleteTempStart)}`);
};

main().catch(err => {
    console.error(err);
    console.error(err.stack);
    setFailed(err);
    process.exit(-1);
})