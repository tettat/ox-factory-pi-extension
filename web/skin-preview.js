document.addEventListener('DOMContentLoaded', () => {
  const samples = document.querySelector('#samples');
  function render() {
    samples.replaceChildren();
    for (const label of ['正在加载页面…', '正在读取消息…', '正在获取记录…']) {
      const node = document.createElement('div');
      node.className = 'page-loading';
      const text = document.createElement('span');
      text.textContent = label;
      node.appendChild(text);
      samples.appendChild(node);
      window.FactorySkin?.decorateLoading(node);
    }
  }
  document.querySelector('#again').addEventListener('click', render);
  render();
});
