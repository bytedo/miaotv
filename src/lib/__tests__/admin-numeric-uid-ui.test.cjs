const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  mountUsers,
  elements,
  text,
  fixtureUsers,
  button,
  aria,
} = require('./admin-user-drawer.test.cjs');

test('user rows display their assigned numeric ID before the username and preserve email/null', (t) => {
  const panel = mountUsers(t, fixtureUsers());
  const headers = elements(panel.find((node) => node.type === 'thead')).filter(
    (node) => node.type === 'th',
  );
  assert.deepEqual(headers.slice(1, 3).map(text), ['ID', '用户名']);
  const rows = panel.rows();
  assert.deepEqual(
    rows.map((row) => row.key),
    ['1', '2', '12'],
  );
  const viewerCells = elements(rows[1]).filter((node) => node.type === 'td');
  assert.equal(text(viewerCells[1]), '2');
  assert.equal(text(viewerCells[2]), 'viewerviewer@example.test');
  const alternateCells = elements(rows[2]).filter((node) => node.type === 'td');
  assert.equal(text(alternateCells[1]), '12');
  assert.equal(text(alternateCells[2]), 'alternatenull');
  assert.ok(
    !elements(rows[0]).some(
      (node) => node.props['aria-label'] === '修改 admin 的用户名',
    ),
  );
});

test('ID search is exact and does not renumber rows or disrupt username/email search', (t) => {
  const panel = mountUsers(t, fixtureUsers());
  const search = (node) =>
    node.type === 'input' && node.props.type === 'search';
  for (const [query, expected] of [
    ['2', ['2']],
    [' 12 ', ['12']],
    ['VIEWER@EXAMPLE', ['2']],
    ['ALTern', ['12']],
    ['9999', []],
  ]) {
    panel.change(search, query);
    assert.deepEqual(
      panel.rows().map((row) => row.key),
      expected,
      query,
    );
    for (const row of panel.rows()) {
      assert.equal(
        text(elements(row).filter((node) => node.type === 'td')[1]),
        row.key,
      );
    }
  }
});

test('rename and selection keep the numeric UID when the old username is reused while the dialog is open', async (t) => {
  const panel = mountUsers(t, fixtureUsers());
  panel.change((node) => node.props['aria-label'] === '选择用户 viewer', {
    checked: true,
  });
  await panel.click(aria('操作 viewer'));
  await panel.click(button('修改用户名'), panel.dialog());
  panel.change(
    (node) => node.props.id === 'admin-rename-new-username',
    'final_name',
  );
  panel.setUsers([
    fixtureUsers()[0],
    { ...fixtureUsers()[1], username: 'renamed_elsewhere' },
    { uid: '25', username: 'viewer', role: 'user' },
  ]);
  assert.equal(
    panel.find(
      (node) => node.props['aria-label'] === '选择用户 renamed_elsewhere',
    ).props.checked,
    true,
  );
  assert.equal(
    panel.find((node) => node.props['aria-label'] === '选择用户 viewer').props
      .checked,
    false,
  );
  await panel.submit();
  assert.deepEqual(panel.requests, [
    { action: 'changeUsername', targetUid: '2', newUsername: 'final_name' },
  ]);
});

test('bulk user actions retain numeric UID strings and never send row positions or usernames', async (t) => {
  const panel = mountUsers(t, fixtureUsers());
  panel.change((node) => node.props['aria-label'] === '选择用户 viewer', {
    checked: true,
  });
  panel.change((node) => node.props['aria-label'] === '选择用户 alternate', {
    checked: true,
  });
  await panel.click(
    (node) => node.type === 'button' && text(node) === '批量设置用户组',
  );
  await panel.click(
    (node) => node.type === 'button' && text(node) === '确认设置',
  );
  assert.deepEqual(panel.requests, [
    { action: 'batchUpdateUserGroups', userUids: ['2', '12'], userGroups: [] },
  ]);
});

test('an administrator can recognize and rename their own account by its numeric UID', async (t) => {
  const users = fixtureUsers().map((user) =>
    user.uid === '12' ? { ...user, role: 'admin' } : user,
  );
  const panel = mountUsers(
    t,
    users,
    { uid: '12', username: 'previous_login_name' },
    'admin',
  );
  assert.equal(panel.rows()[0].key, '12');
  assert.ok(text(panel.rows()[0]).includes('当前'));
  await panel.open('12');
  assert.equal(
    panel.find(button('修改用户名'), panel.dialog()).props.disabled,
    false,
  );
});
