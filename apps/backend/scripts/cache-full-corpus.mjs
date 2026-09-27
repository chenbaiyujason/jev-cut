import {rebuildCorpusCache,corpusFile} from '../corpus-cache.mjs';
const result=await rebuildCorpusCache();console.log(JSON.stringify({file:corpusFile,...result.stats},null,2));
