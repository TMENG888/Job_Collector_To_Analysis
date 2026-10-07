import path from 'node:path';

export function datasetOwner(tasks, filePath) {
  const directory = path.dirname(path.resolve(filePath)).toLowerCase();
  // Exports are written directly to outputDir. A broad parent directory does
  // not establish ownership of files exported by independent nested tasks.
  return tasks.find((task) => task.outputDir && path.resolve(task.outputDir).toLowerCase() === directory) || null;
}
