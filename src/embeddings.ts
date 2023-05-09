import joplin from 'api';
import * as tf from '@tensorflow/tfjs';
import * as use from '@tensorflow-models/universal-sentence-encoder';
import { createHash } from 'crypto';
import { JarvisSettings } from './settings';
import { delete_note_and_embeddings, insert_note_embeddings } from './db';

const max_block_size = 512 / 1.5;  // max no. of words per block, TODO: add to settings

export interface BlockEmbedding {
  id: string;  // note id
  hash: string;  // note content hash
  line: number;  // line no. in the note where the block starts
  body_idx: number;  // index in note.body
  length: number;  // length of block
  level: number;  // heading level
  title: string;  // heading title
  embedding: Float32Array;  // block embedding
  similarity: number;  // similarity to the query
}

export interface NoteEmbedding {
  id: string;  // note id
  title: string;  // note title
  embeddings: BlockEmbedding[];  // block embeddings
  similarity: number;  // representative similarity to the query
}

tf.setBackend('webgl');

export async function load_model(settings: JarvisSettings): Promise<use.UniversalSentenceEncoder> {
  try {
    return await use.load();
  } catch (e) {
    console.log(`load_model failed: ${e}`);
    return null;
  }
}

// calculate the embeddings for a note
export async function calc_note_embeddings(note: any, model: use.UniversalSentenceEncoder, max_block_size: number): Promise<BlockEmbedding[]> {
  const hash = calc_hash(note.body);
  note.body = convert_newlines(note.body);
  let level = 0;
  let title = note.title;
  let path = [title, '', '', '', '', '', ''];  // block path

  // separate blocks using the note's headings, but avoid splitting within code sections
  const regex = /(^```[\s\S]*?```$)|(^#+\s.*)/gm;
  const blocks: BlockEmbedding[][] = note.body.split(regex).filter(Boolean).map(
    async (block: string): Promise<BlockEmbedding[]> => {

      // parse the heading title and level from the main block
      // use the last known level/title as a default
      const is_code_block = block.startsWith('```');
      if (is_code_block) {
        const parse_heading = block.match(/```(.*)/);
        if (parse_heading) { title = parse_heading[1] + ' '; }
        title += 'code block';
      } else {
        const parse_heading = block.match(/^(#+)\s(.*)/);
        if (parse_heading) {
          level = parse_heading[1].length;
          title = parse_heading[2];
        }
      }
      if (level > 6) { level = 6; }  // max heading level is 6
      path[level] = title;

      const sub_blocks = split_block_to_max_size(block, max_block_size, is_code_block);

      const sub_embd = sub_blocks.map(async (sub: string): Promise<BlockEmbedding> => {
        const [line, body_idx] = calc_line_number(note.body, block, sub);
        return {
          id: note.id,
          hash: hash,
          line: line,
          body_idx: body_idx,
          length: sub.length,
          level: level,
          title: title,
          embedding: await calc_block_embeddings(model, [path.slice(0, level+1).join('/') + ':' + sub]),
          similarity: 0,
        };
      });
      return Promise.all(sub_embd);
    }
  );

  return Promise.all(blocks).then(blocks => [].concat(...blocks));
}

function split_block_to_max_size(block: string, max_size: number, is_code_block: boolean): string[] {
  if (is_code_block) {
    return split_code_block_by_lines(block, max_size);
  } else {
    return split_text_block_by_sentences_and_newlines(block, max_size);
  }
}

function split_code_block_by_lines(block: string, max_size: number): string[] {
  const lines = block.split('\n');
  const blocks: string[] = [];
  let current_block = '';
  let current_size = 0;

  lines.forEach(line => {
    // TODO: probably need a better count than words
    const words = line.split(/\s+/).length;
    if (current_size + words <= max_size) {
      current_block += line + '\n';
      current_size += words;
    } else {
      blocks.push(current_block);
      current_block = line + '\n';
      current_size = words;
    }
  });

  if (current_block) {
    blocks.push(current_block);
  }

  return blocks;
}

function split_text_block_by_sentences_and_newlines(block: string, max_size: number): string[] {
  const segments = block.match(/[^\.!\?\n]+[\.!\?\n]+/g) || [];
  let current_size = 0;
  let current_block = '';
  const blocks: string[] = [];

  segments.forEach(segment => {
    const words = segment.split(/\s+/).length;
    if (current_size + words <= max_size) {
      current_block += segment;
      current_size += words;
    } else {
      blocks.push(current_block);
      current_block = segment;
      current_size = words;
    }
  });

  if (current_block) {
    blocks.push(current_block);
  }

  return blocks;
}

function calc_line_number(note_body: string, block: string, sub: string): [number, number] {
  const block_start = note_body.indexOf(block);
  const sub_start = Math.max(0, block.indexOf(sub));
  let line_number = note_body.substring(0, block_start + sub_start).split('\n').length;

  if (!sub.startsWith('```')) {
    line_number -= 2;
  }

  return [line_number, block_start + sub_start];
}

// calculate the embedding for a block of text
export async function calc_block_embeddings(model: use.UniversalSentenceEncoder, text_blocks: string[]):
  Promise<Float32Array> {
  const embeddings = await model.embed(text_blocks);
  let vec = (await embeddings.data()) as Float32Array;
  // normalize the vector
  const norm = Math.sqrt(vec.map(x => x*x).reduce((a, b) => a + b, 0));
  vec = vec.map(x => x / norm);
  return vec;
}

// async function to process a single note
async function update_note(note: any, embeddings: BlockEmbedding[],
    model: use.UniversalSentenceEncoder, db: any): Promise<BlockEmbedding[]> {
  if (note.is_conflict) {
    return [];
  }
  const note_tags = (await joplin.data.get(['notes', note.id, 'tags'], { fields: ['title'] }))
    .items.map((t: any) => t.title);
  if (note_tags.includes('exclude.from.jarvis')) {
    console.log(`Excluding note ${note.id} from Jarvis`);
    delete_note_and_embeddings(db, note.id);
    return [];
  }

  const hash = calc_hash(note.body);
  const old_embd = embeddings.filter((embd: BlockEmbedding) => embd.id === note.id);

  // if the note hasn't changed, return the old embeddings
  if ((old_embd.length > 0) && (old_embd[0].hash === hash)) {
    return old_embd;
  }

  // otherwise, calculate the new embeddings
  const new_embd = await calc_note_embeddings(note, model, max_block_size);

  // insert new embeddings into DB
  await insert_note_embeddings(db, new_embd);

  return new_embd;
}

export async function update_embeddings(db: any, embeddings: BlockEmbedding[],
    notes: any[], model: use.UniversalSentenceEncoder): Promise<BlockEmbedding[]> {
  // map over the notes array and create an array of promises
  const notes_promises = notes.map(note => update_note(note, embeddings, model, db));

  // wait for all promises to resolve and store the result in new_embeddings
  const new_embeddings = await Promise.all(notes_promises);

  return [].concat(...new_embeddings);
}

export async function extract_blocks_text(embeddings: BlockEmbedding[], max_length: number): Promise<string> {
  let text: string = '';
  let embd: BlockEmbedding;
  for (let i=0; i<embeddings.length; i++) {
    embd = embeddings[i];
    if (embd.body_idx < 0) {
      // unknown position in note (rare case)
      console.log(`extract_blocks_text: skipped ${embd.id} : ${embd.line} / ${embd.title}`);
      continue;
    }

    const note = await joplin.data.get(['notes', embd.id], { fields: ['title', 'body']});
    const block_text = note.body.substring(embd.body_idx, embd.body_idx + embd.length);

    let decoration = `# note ${i+1}:\n${note.title}`;
    if (embd.title !== note.title) {
      decoration += `/${embd.title}`;
    }
    if (text.length + decoration.length + block_text.length > max_length) {
      break;
    }
    text += decoration + '\n' + block_text;
  };
  return text;
}

export function extract_blocks_links(embeddings: BlockEmbedding[]): string {
  let links: string = '';
  for (let i=0; i<embeddings.length; i++) {
    if (embeddings[i].level > 0) {
      links += `[${i+1}](:/${embeddings[i].id}#${get_slug(embeddings[i].title)}), `;
    } else {
      links += `[${i+1}](:/${embeddings[i].id}), `;
    }
  };
  return links.substring(0, links.length-2);
}

function get_slug(title: string): string {
  return title
      .toLowerCase()                        // convert to lowercase
      .replace(/\s+/g, '-')                 // replace spaces with hyphens
      .replace(/[^a-z0-9\-]+/g, '')         // remove non-alphanumeric characters except hyphens
      .replace(/-+/g, '-')                  // replace multiple hyphens with a single hyphen
      .replace(/^-|-$/g, '');               // remove hyphens at the beginning and end of the string
}

// given a list of embeddings, find the nearest ones to the query
export async function find_nearest_notes(embeddings: BlockEmbedding[], current_id: string, query: string,
    model: use.UniversalSentenceEncoder, settings: JarvisSettings, return_grouped_notes: boolean=true):
    Promise<NoteEmbedding[]> {

  const query_embeddings = await calc_note_embeddings(
    {id: 'query', body: query, title: 'query'}, model, max_block_size);
  if (query_embeddings.length === 0) {
    return [];
  }
  const rep_embedding = calc_mean_embedding(query_embeddings);

  // calculate the similarity between the query and each embedding, and filter by it
  const nearest = (await Promise.all(embeddings.map(
    async (embed: BlockEmbedding): Promise<BlockEmbedding> => {
    embed.similarity = await calc_similarity(rep_embedding, embed.embedding);
    return embed;
  }
  ))).filter((embd) => (embd.similarity >= settings.notes_min_similarity) && (embd.id !== current_id));

  if (!return_grouped_notes) {
    // return the sorted list of block embeddings in a NoteEmbdedding[] object
    return [{
      id: null,
      title: null,
      embeddings: nearest.sort((a, b) => b.similarity - a.similarity).slice(0, settings.notes_max_hits),
      similarity: null,
    }];
  }

  // group the embeddings by note id
  const grouped = nearest.reduce((acc: {[note_id: string]: BlockEmbedding[]}, embed) => {
    if (!acc[embed.id]) {
      acc[embed.id] = [];
    }
    acc[embed.id].push(embed);
    return acc;
  }, {});

  // sort the groups by their average similarity
  return (await Promise.all(Object.entries(grouped).map(async ([note_id, note_embed]) => {
    const sorted_embed = note_embed.sort((a, b) => b.similarity - a.similarity);

    let agg_sim: number;
    if (settings.notes_agg_similarity === 'max') {
      agg_sim = sorted_embed[0].similarity;
    } else if (settings.notes_agg_similarity === 'avg') {
      agg_sim = sorted_embed.reduce((acc, embd) => acc + embd.similarity, 0) / sorted_embed.length;
    }

    return {
      id: note_id,
      title: (await joplin.data.get(['notes', note_id], {fields: ['title']})).title,
      embeddings: sorted_embed,
      similarity: agg_sim,
    };
    }))).sort((a, b) => b.similarity - a.similarity).slice(0, settings.notes_max_hits);
}

// calculate the cosine similarity between two embeddings
export async function calc_similarity(embedding1: Float32Array, embedding2: Float32Array): Promise<number> {
  let sim = 0;
  for (let i = 0; i < embedding1.length; i++) {
    sim += embedding1[i] * embedding2[i];
  }
  return sim;
}

function calc_mean_embedding(embeddings: BlockEmbedding[]): Float32Array {
  return embeddings.reduce((acc, embd) => {
    for (let i = 0; i < acc.length; i++) {
      acc[i] += embd.embedding[i];
    }
    return acc;
  }, new Float32Array(embeddings[0].embedding.length)).map(x => x / embeddings.length);
}

// calculate the hash of a string
function calc_hash(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function convert_newlines(str: string): string {
  return str.replace(/\r\n|\r/g, '\n');
}
