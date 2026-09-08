async function loadAppData() {
  try {
    const response = await fetch('data.json');
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to load app data:', error);
    return null;
  }
}

// Global state for calculations
let scores = {};

function calculateTotal() {
  let colSums = [0, 0, 0, 0];
  let total = 0;

  for (const qId in scores) {
    const val = scores[qId];
    colSums[val] += val;
    total += val;
  }

  // Update UI for office coding
  document.getElementById('calc-col-0').textContent = colSums[0];
  document.getElementById('calc-col-1').textContent = colSums[1];
  document.getElementById('calc-col-2').textContent = colSums[2];
  document.getElementById('calc-col-3').textContent = colSums[3];
  document.getElementById('calc-total').textContent = total;
}

async function init() {
  const data = await loadAppData();
  if (!data) return;

  const settings = data.sections.app_settings;
  document.documentElement.style.setProperty('--primary-color', settings.primary_color.value);
  document.documentElement.style.setProperty('--background-color', settings.background_color.value);
  document.documentElement.style.setProperty('--text-color', settings.text_color.value);

  const options = data.sections.options.value;
  const optionsHeader = document.getElementById('options-header');

  options.forEach((opt, idx) => {
    const col = document.createElement('div');
    col.className = 'th-option-label';
    col.setAttribute('data-bind-text', `options.${idx}.label`);
    col.textContent = opt.label;
    optionsHeader.appendChild(col);
  });

  const questions = data.sections.questions.value;
  const container = document.getElementById('questions-container');

  questions.forEach((q, originalIdx) => {
    const row = document.createElement('div');
    row.className = 'question-row';

    const textDiv = document.createElement('div');
    textDiv.className = 'question-text';
    textDiv.setAttribute('data-bind-text', `questions.${originalIdx}.text`);
    textDiv.textContent = q.text;
    row.appendChild(textDiv);

    const optsDiv = document.createElement('div');
    optsDiv.className = 'question-options';

    options.forEach(opt => {
      const radioContainer = document.createElement('label');
      radioContainer.className = 'radio-container';

      const valSpan = document.createElement('span');
      valSpan.className = 'option-value';
      valSpan.textContent = opt.value;

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `question_${q.id}`;
      radio.value = opt.value;

      radio.addEventListener('change', (e) => {
        scores[q.id] = parseInt(e.target.value, 10);
        calculateTotal();
      });

      radioContainer.appendChild(valSpan);
      radioContainer.appendChild(radio);
      optsDiv.appendChild(radioContainer);
    });

    row.appendChild(optsDiv);
    container.appendChild(row);
  });

  // Difficulty section
  const diffOptions = data.sections.difficulty_options.value;
  const diffContainer = document.getElementById('difficulty-options-container');

  diffOptions.forEach((opt, idx) => {
    const group = document.createElement('div');
    group.className = 'diff-radio-group';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'difficulty';
    radio.value = opt.id;

    const label = document.createElement('label');
    label.setAttribute('data-bind-text', `difficulty_options.${idx}.label`);
    label.textContent = opt.label;

    group.appendChild(label);
    group.appendChild(radio);
    diffContainer.appendChild(group);
  });

  if (window.SkoopLive) window.SkoopLive.apply(data);
  document.getElementById('app-container').classList.add('loaded');
}

init();