(() => {
  // Entries with kind "value" are ordinary choices and require no installed skill.
  window.createSkillSelect = function (select, { onChange, onSetup, onAdd }) {
    let entries = [],
      available = null,
      selected = '';
    const setupValue = '__setup_skills__';
    function render() {
      const names = available && new Set(available.map((skill) => skill.name));
      const missing = names ? entries.filter((entry) => entry.kind === 'skill' && !names.has(entry.skill)) : [];
      const options = entries.map((entry) => {
        const option = new Option(entry.label, entry.name);
        option.disabled = missing.includes(entry);
        return { entry, option };
      });
      const nodes = options.filter(({ entry }) => entry.kind === 'skill').map(({ option }) => option);
      if (missing.length) nodes.push(new Option('Set up skills', setupValue));
      if (onAdd) nodes.push(new Option('Add skill…', '__add_skill__'));
      nodes.push(...options.filter(({ entry }) => entry.kind === 'value').map(({ option }) => option));
      select.replaceChildren(...nodes);
      select.value = selected;
    }
    select.addEventListener('change', () => {
      if (select.value === '__add_skill__') {
        select.value = selected;
        void onAdd();
      } else if (select.value === setupValue) {
        select.value = selected;
        void onSetup(entries.filter((entry) => entry.kind === 'skill').map((entry) => entry.skill));
      } else {
        selected = select.value;
        onChange(selected);
      }
    });
    return {
      update(options, value) {
        entries = options;
        selected = value;
        render();
      },
      discovered(skills) {
        available = skills;
        render();
      },
    };
  };
})();
