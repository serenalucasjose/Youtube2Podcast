#!/usr/bin/env node
/**
 * Script para importar feeds RSS desde el repositorio awesome-rss-feeds
 * https://github.com/plenaryapp/awesome-rss-feeds
 * 
 * Uso: node scripts/import_rss_feeds.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

// Importar db
const dbPath = path.join(__dirname, '../data/youtube2podcast.db');
const Database = require('better-sqlite3');

// Asegurar que el directorio data existe
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Inicializar tabla rss_feeds si no existe
db.exec(`
  CREATE TABLE IF NOT EXISTS rss_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    language TEXT DEFAULT 'en',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

/**
 * Descarga el contenido de una URL
 */
function downloadUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

/**
 * Parsea el README markdown y extrae feeds RSS organizados por categoría
 */
function parseMarkdownFeeds(markdown) {
    const feeds = [];
    
    // Dividir por secciones de categorías (líneas que empiezan con ###)
    const categorySections = markdown.split(/^### /gm);
    
    for (let i = 1; i < categorySections.length; i++) {
        const section = categorySections[i];
        const lines = section.split('\n');
        
        // Primera línea es el nombre de la categoría (puede tener emojis)
        let categoryName = lines[0].trim();
        // Remover emojis de banderas y limpiar (simplemente buscar el primer espacio o letra)
        // Las banderas de países suelen estar al inicio seguidos de espacio
        categoryName = categoryName.replace(/^[^\w\s]*\s*/, '').trim();
        // Si aún tiene caracteres especiales al inicio, intentar otra vez
        if (categoryName && !/^[A-Za-z]/.test(categoryName)) {
            categoryName = categoryName.replace(/^[^A-Za-z]+\s*/, '').trim();
        }
        if (!categoryName) continue;
        
        // Buscar la tabla de feeds (formato markdown table)
        let inTable = false;
        let tableStartIndex = -1;
        let headerFound = false;
        
        for (let j = 0; j < lines.length; j++) {
            const line = lines[j].trim();
            
            // Detectar inicio de tabla (línea con | Title | RSS Feed Url | o | Source | Primary Feed Url |)
            // También puede ser sin pipes al inicio: "Title | RSS Feed Url | Domain"
            if (line.match(/^(?:\|)?\s*(?:Title|Source).*?(?:RSS.*Feed.*Url|Primary.*Feed.*Url|Feed)/i)) {
                inTable = true;
                headerFound = true;
                continue;
            }
            
            // Detectar separador de tabla (línea con guiones: "-------|------------------|----------")
            if (headerFound && line.match(/^[\s\-:|]+$/)) {
                tableStartIndex = j + 1;
                continue;
            }
            
            // Si estamos en una tabla y encontramos una fila de datos
            // Puede empezar con | o sin él
            if (inTable && tableStartIndex > 0 && j >= tableStartIndex && (line.startsWith('|') || line.includes('http'))) {
                // Parsear fila de tabla: | Title | RSS Feed Url | Domain |
                // Asegurar que tenga pipes
                const lineWithPipes = line.startsWith('|') ? line : '| ' + line.replace(/\s+\|\s+/, ' | ');
                const cells = lineWithPipes.split('|').map(c => c.trim()).filter(c => c && c !== '');
                
                if (cells.length >= 2) {
                    const title = cells[0];
                    let rssUrl = cells[1];
                    
                    // Limpiar URL (puede tener < > o ser un link markdown)
                    rssUrl = rssUrl
                        .replace(/^<|>$/g, '') // Remover < >
                        .replace(/^\[.*?\]\((.*?)\)$/, '$1') // Extraer URL de [text](url)
                        .trim();
                    
                    // Validar que sea una URL válida
                    if (rssUrl && (rssUrl.startsWith('http://') || rssUrl.startsWith('https://'))) {
                        // Detectar idioma basado en el dominio o categoría
                        let language = 'en';
                        const categoryLower = categoryName.toLowerCase();
                        const urlLower = rssUrl.toLowerCase();
                        
                        if (urlLower.includes('.es/') || categoryLower.includes('spain') || categoryLower.includes('españ')) {
                            language = 'es';
                        } else if (urlLower.includes('.fr/') || categoryLower.includes('france') || categoryLower.includes('franç')) {
                            language = 'fr';
                        } else if (urlLower.includes('.de/') || categoryLower.includes('germany') || categoryLower.includes('deutsch')) {
                            language = 'de';
                        } else if (urlLower.includes('.pt/') || categoryLower.includes('brazil') || categoryLower.includes('portug')) {
                            language = 'pt';
                        } else if (categoryLower.includes('canada') || categoryLower.includes('australia') || categoryLower.includes('united kingdom') || categoryLower.includes('united states')) {
                            language = 'en';
                        }
                        
                        feeds.push({
                            name: title,
                            url: rssUrl,
                            category: categoryName,
                            language: language
                        });
                    }
                }
            }
            
            // Detectar fin de tabla (línea vacía o nueva sección)
            if (inTable && (line === '' || line.startsWith('##') || line.startsWith('#'))) {
                inTable = false;
                headerFound = false;
                tableStartIndex = -1;
            }
        }
    }
    
    return feeds;
}

/**
 * Parsea un archivo OPML y extrae feeds RSS
 */
function parseOPML(opmlContent) {
    const feeds = [];
    
    return new Promise((resolve, reject) => {
        const parser = new xml2js.Parser({
            trim: true,
            explicitArray: false,
            mergeAttrs: true,
            ignoreAttrs: false,
            explicitCharkey: false,
            attrkey: '_attr',
            charkey: '_text',
            // Opciones para manejar XML mal formado
            normalize: true,
            normalizeTags: false,
            explicitRoot: true
        });
        
        parser.parseString(opmlContent, (err, result) => {
            if (err) {
                reject(err);
                return;
            }
            
            function extractFeeds(outline, category = 'General') {
                if (!outline) return;
                
                if (Array.isArray(outline)) {
                    outline.forEach(item => extractFeeds(item, category));
                } else if (typeof outline === 'object') {
                    // Si tiene xmlUrl, es un feed
                    if (outline.xmlUrl) {
                        feeds.push({
                            name: outline.text || outline.title || 'Sin título',
                            url: outline.xmlUrl,
                            category: outline.category || category,
                            language: 'en'
                        });
                    }
                    
                    // Si tiene outlines anidados, procesarlos
                    if (outline.outline) {
                        const newCategory = outline.text || outline.title || category;
                        extractFeeds(outline.outline, newCategory);
                    }
                }
            }
            
            if (result.opml && result.opml.body && result.opml.body[0] && result.opml.body[0].outline) {
                extractFeeds(result.opml.body[0].outline);
            }
            
            resolve(feeds);
        });
    });
}

/**
 * Importa feeds desde archivos OPML de categorías recomendadas
 */
async function importFromOPML() {
    const categories = [
        'Tech', 'News', 'Science', 'Programming', 'Business & Economy',
        'Sports', 'Gaming', 'Movies', 'Music', 'Travel', 'Food'
    ];
    
    const allFeeds = [];
    
    for (const category of categories) {
        try {
            const opmlUrl = `https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/${encodeURIComponent(category)}.opml`;
            console.log(`[Import] Descargando OPML para categoría: ${category}...`);
            
            const opmlContent = await downloadUrl(opmlUrl);
            const feeds = await parseOPML(opmlContent);
            
            // Asignar categoría y detectar idioma
            feeds.forEach(feed => {
                feed.category = category;
                // Detectar idioma basado en URL
                if (feed.url.includes('.es/')) feed.language = 'es';
                else if (feed.url.includes('.fr/')) feed.language = 'fr';
                else if (feed.url.includes('.de/')) feed.language = 'de';
                else if (feed.url.includes('.pt/')) feed.language = 'pt';
                else feed.language = 'en';
            });
            
            allFeeds.push(...feeds);
            console.log(`[Import] Encontrados ${feeds.length} feeds en ${category}`);
        } catch (error) {
            console.warn(`[Import] No se pudo descargar OPML para ${category}:`, error.message);
        }
    }
    
    return allFeeds;
}

/**
 * Importa feeds a la base de datos
 */
async function importFeeds() {
    console.log('[Import] Iniciando importación de feeds RSS...\n');
    
    try {
        let allFeeds = [];
        
        // Método 1: Parsear README
        console.log('[Import] Método 1: Parseando README del repositorio...');
        try {
            const readmeUrl = 'https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/README.md';
            const markdown = await downloadUrl(readmeUrl);
            const feedsFromReadme = parseMarkdownFeeds(markdown);
            console.log(`[Import] Encontrados ${feedsFromReadme.length} feeds en README`);
            allFeeds.push(...feedsFromReadme);
        } catch (error) {
            console.warn('[Import] Error parseando README:', error.message);
        }
        
        // Método 2: Parsear archivos OPML (más confiable)
        console.log('\n[Import] Método 2: Descargando archivos OPML...');
        try {
            const feedsFromOPML = await importFromOPML();
            console.log(`[Import] Encontrados ${feedsFromOPML.length} feeds en OPML`);
            allFeeds.push(...feedsFromOPML);
        } catch (error) {
            console.warn('[Import] Error parseando OPML:', error.message);
        }
        
        // Eliminar duplicados (misma URL)
        const uniqueFeeds = [];
        const seenUrls = new Set();
        
        for (const feed of allFeeds) {
            if (!seenUrls.has(feed.url)) {
                seenUrls.add(feed.url);
                uniqueFeeds.push(feed);
            }
        }
        
        console.log(`\n[Import] Total de feeds únicos: ${uniqueFeeds.length}`);
        
        // Filtrar solo feeds en español
        const spanishFeeds = uniqueFeeds.filter(feed => feed.language === 'es');
        console.log(`[Import] Feeds en español: ${spanishFeeds.length}`);
        
        // Preparar statement para insertar
        const insertStmt = db.prepare('INSERT OR IGNORE INTO rss_feeds (name, url, category, language) VALUES (?, ?, ?, ?)');
        const insertMany = db.transaction((feeds) => {
            for (const feed of feeds) {
                insertStmt.run(feed.name, feed.url, feed.category, feed.language);
            }
        });
        
        // Insertar solo feeds en español
        console.log('[Import] Insertando feeds en español en la base de datos...');
        insertMany(spanishFeeds);
        
        // Estadísticas
        const stats = db.prepare(`
            SELECT 
                category,
                COUNT(*) as count
            FROM rss_feeds
            GROUP BY category
            ORDER BY category
        `).all();
        
        console.log('\n[Import] ✅ Importación completada!\n');
        console.log('Estadísticas por categoría:');
        console.log('─'.repeat(50));
        stats.forEach(stat => {
            console.log(`  ${stat.category}: ${stat.count} feeds`);
        });
        
        const total = db.prepare('SELECT COUNT(*) as count FROM rss_feeds').get().count;
        console.log('─'.repeat(50));
        console.log(`  Total: ${total} feeds`);
        
    } catch (error) {
        console.error('[Import] ❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        db.close();
    }
}

// Ejecutar importación
if (require.main === module) {
    importFeeds();
}

module.exports = { importFeeds, parseMarkdownFeeds };

