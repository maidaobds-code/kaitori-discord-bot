import axios from 'axios';

const url = 'https://pastec.net/iphone?series_child_id=644';
const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
const text = data.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
console.log('has iPhone18', /iPhone18/gi.test(text));
console.log('has Pro Max', /Pro Max/gi.test(text));
console.log('has 256GB', /256GB/gi.test(text));
console.log('sample match on title', text.match(/iPhone\s*18\s*(?:Pro\s*Max|Pro)\s*(?:128|256|512)GB/gi)?.slice(0, 10));
console.log('sample 1', text.match(/iPhone\s*18\s*(?:Pro\s*Max|Pro)\s*(?:128|256|512)GB\s*[^\n]{0,20}未開封品買取価格\s*([0-9,]+)円/gi)?.slice(0, 10));
console.log('sample 2', text.match(/未開封品買取価格\s*([0-9,]+)円/gi)?.slice(0, 10));
console.log('sample 3', text.match(/iPhone\s*18\s*(?:Pro\s*Max|Pro)\s*(?:128|256|512)GB[^\n]{0,80}([0-9,]{3,9})円/gi)?.slice(0, 10));
