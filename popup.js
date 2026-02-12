document.addEventListener('DOMContentLoaded', async () => {
  const API_ENDPOINT = "https://dasfdedcymvskruytqxr.supabase.co/functions/v1/save-content";

  const els = {
    settingsBtn: document.getElementById('settingsBtn'),
    settingsView: document.getElementById('settingsView'),
    mainView: document.getElementById('mainView'),
    backBtn: document.getElementById('backBtn'),
    saveBtn: document.getElementById('saveBtn'),
    testBtn: document.getElementById('testBtn'),
    clipBtn: document.getElementById('clipBtn'),
    // apiUrl removed from UI
    apiKey: document.getElementById('apiKey'),
    status: document.getElementById('status'),
    pageTitle: document.getElementById('pageTitle'),
    clipStatus: document.getElementById('clipStatus'),
    loading: document.getElementById('loading')
  };

  // 1. Safe Storage Helper (Try Sync, Fallback to Local)
  const getStorage = (keys) => {
    return new Promise((resolve) => {
      // Try sync first
      chrome.storage.sync.get(keys, (syncRes) => {
        if (chrome.runtime.lastError || !syncRes || Object.keys(syncRes).length === 0) {
          // Fallback to local
          chrome.storage.local.get(keys, (localRes) => {
            resolve(localRes || {});
          });
        } else {
          resolve(syncRes);
        }
      });
    });
  };

  const setStorage = (data) => {
    return new Promise((resolve) => {
      // Save to BOTH to be safe
      chrome.storage.local.set(data, () => {
        chrome.storage.sync.set(data, () => {
          resolve();
        });
      });
    });
  };

  // 2. Initialize
  const config = await getStorage(['echomindApiKey']);
  
  if (config.echomindApiKey) els.apiKey.value = config.echomindApiKey;

  // Auto-fill page title
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    els.pageTitle.value = tab.title || 'Untitled Page';
  }

  // Show settings if no key found
  if (!config.echomindApiKey) {
    showSettings(true);
  }

  // 3. Navigation Handlers
  els.settingsBtn.addEventListener('click', () => showSettings(true));
  els.backBtn.addEventListener('click', () => showSettings(false));

  function showSettings(show) {
    if (show) {
      els.settingsView.classList.remove('hidden');
      els.mainView.classList.add('hidden');
    } else {
      els.settingsView.classList.add('hidden');
      els.mainView.classList.remove('hidden');
      els.status.textContent = '';
    }
  }

  function showStatus(element, msg, type) {
    element.textContent = msg;
    element.className = 'status ' + type;
  }

  // 4. Save Settings
  els.saveBtn.addEventListener('click', async () => {
    const key = els.apiKey.value.trim();

    if (!key) {
      showStatus(els.status, 'Please enter your API Key.', 'error');
      return;
    }

    await setStorage({
      echomindApiKey: key
    });

    showStatus(els.status, 'Settings saved!', 'success');
    setTimeout(() => showSettings(false), 1000);
  });

  // 5. Test Connection (Real Auth Check)
  els.testBtn.addEventListener('click', async () => {
    const key = els.apiKey.value.trim();
    const url = API_ENDPOINT;

    if (!key) {
      showStatus(els.status, 'Enter API Key first.', 'error');
      return;
    }

    showStatus(els.status, 'Testing connection...', '');

    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 10000); // 10s timeout

      // Construct URL with Fallback Param
      let targetUrl = url;
      try {
          const urlObj = new URL(url);
          urlObj.searchParams.set('apikey', key);
          targetUrl = urlObj.toString();
      } catch(e) { console.error(e); }

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key // Send in Header too
        },
        body: JSON.stringify({ 
            title: 'Test Connection', 
            content: 'Ping', 
            url: 'http://test', 
            tags: ['test'] 
        }),
        signal: controller.signal
      });
      clearTimeout(id);

      if (res.ok) {
        showStatus(els.status, 'Connection Successful!', 'success');
      } else {
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
            showStatus(els.status, `Invalid API Key (${res.status})`, 'error');
        } else if (res.status === 404) {
            showStatus(els.status, 'Wrong URL (404 Not Found)', 'error');
        } else {
            showStatus(els.status, `Error: ${res.status} ${text.substring(0, 50)}`, 'error');
        }
      }
    } catch (e) {
      showStatus(els.status, 'Network Error: ' + e.message, 'error');
    }
  });

  // 6. Clip Content
  els.clipBtn.addEventListener('click', async () => {
    els.clipBtn.classList.add('hidden');
    els.loading.classList.remove('hidden');
    showStatus(els.clipStatus, '', '');

    try {
      // A. Get Configuration
      const config = await getStorage(['echomindApiKey']);
      const apiUrl = API_ENDPOINT;
      
      if (!config.echomindApiKey) {
        throw new Error("Missing API Key. Please check settings.");
      }

      // B. Get Page Content
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let pageContent = '';
      let pageUrl = tab.url;
      const pageTitle = els.pageTitle.value || tab.title;

      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // --- SMART SCRAPER START ---
            
            // 1. Funktion zum Entfernen von Müll (Werbung, Menüs, Footer)
            function cleanup(root) {
              const clone = root.cloneNode(true);
              const badSelectors = [
                'script', 'style', 'noscript', 'iframe', 'svg',
                'nav', 'footer', 'header', 'aside', 
                '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
                '.ads', '.cookie', '.popup', '#sidebar', '.share-buttons', '.comments'
              ];
              
              try {
                badSelectors.forEach(sel => {
                  const elements = clone.querySelectorAll(sel);
                  elements.forEach(el => el.remove());
                });
              } catch(e) { /* Fehler ignorieren, weitermachen */ }
              
              return clone;
            }

            // 2. Den Hauptinhalt suchen (statt alles zu nehmen)
            // Wir prüfen der Reihe nach, ob diese Bereiche existieren
            const selectors = [
              'article',            // Beste Option
              '[role="main"]',      // Sehr gut
              'main',               // Standard HTML5
              '.post-content',      // Wordpress oft
              '#content',           
              '#main'
            ];

            let contentEl = null;
            
            // Suche den ersten Selektor, der existiert und genug Text hat
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              // Nur nehmen, wenn mehr als 200 Zeichen drin sind (um leere Container zu vermeiden)
              if (el && el.innerText.length > 200) {
                contentEl = el;
                break;
              }
            }

            // Fallback: Wenn gar nichts gefunden wird, nimm den Body (aber bereinigt)
            if (!contentEl) contentEl = document.body;

            // 3. Bereinigen und Text zurückgeben
            const cleanElement = cleanup(contentEl);
            
            // Text holen und unnötige Leerzeilen (mehr als 2) entfernen
            let text = cleanElement.innerText;
            return text.replace(/\n\s*\n/g, '\n\n').trim();
            
            // --- SMART SCRAPER END ---
          }
        });
        pageContent = result[0].result;
      } catch (scriptErr) {
        console.warn("Script injection failed, using title only.", scriptErr);
        pageContent = "Content could not be extracted (Restricted Page).";
      }

      // C. Send to API
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 15000); // 15s timeout

      // Add API Key to URL (Fallback strategy)
      let targetUrl = apiUrl;
      try {
          const urlObj = new URL(apiUrl);
          urlObj.searchParams.set('apikey', config.echomindApiKey);
          targetUrl = urlObj.toString();
      } catch(e) { console.error(e); }

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.echomindApiKey
        },
        body: JSON.stringify({
          title: pageTitle,
          content: pageContent,
          url: pageUrl,
          tags: ['web-clip', 'extension']
        }),
        signal: controller.signal
      });
      clearTimeout(id);

      if (response.ok) {
        showStatus(els.clipStatus, 'Saved to Echomind!', 'success');
        setTimeout(() => window.close(), 1500);
      } else {
        const isJson = response.headers.get('content-type')?.includes('application/json');
        let errMsg = `Server Error (${response.status})`;
        
        if (isJson) {
            const errJson = await response.json();
            errMsg = errJson.error || errMsg;
        } else {
            const text = await response.text();
            console.error("Non-JSON Response:", text);
        }
        
        throw new Error(errMsg);
      }

    } catch (e) {
      console.error(e);
      showStatus(els.clipStatus, 'Error: ' + e.message, 'error');
      els.clipBtn.classList.remove('hidden');
      els.loading.classList.add('hidden');
    }
  });
});