const message = document.getElementById('message');
const items = document.getElementById('items');

function renderConversations(rows) {
  items.replaceChildren();
  for (const row of rows) {
    const card = document.createElement('article');
    for (const [label, value] of [['Input', row.user_prompt], ['Output', row.agent_response]]) {
      const line = document.createElement('p');
      const heading = document.createElement('span');
      heading.className = 'label';
      heading.textContent = label;
      line.append(heading, document.createTextNode(value || ''));
      card.appendChild(line);
    }
    const date = document.createElement('time');
    date.textContent = row.timestamp || '';
    card.appendChild(date);
    items.appendChild(card);
  }
  message.textContent = rows.length ? `${rows.length} saved conversation${rows.length === 1 ? '' : 's'}.` : 'No saved conversations yet.';
}

async function loadConversations() {
  message.textContent = 'Loading conversations…';
  try {
    const response = await fetch('/api/history');
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Could not load conversation history.');
    renderConversations(result.logs || []);
  } catch (error) {
    message.textContent = error.message || 'Could not connect to the server.';
  }
}

document.getElementById('refresh').addEventListener('click', loadConversations);
void loadConversations();
