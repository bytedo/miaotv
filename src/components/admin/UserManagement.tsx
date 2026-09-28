'use client';

import {
  ArrowLeft,
  Clock,
  MoreHorizontal,
  Plus,
  Search,
  Users,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import './user-management-drawer.css';

import {
  getRegistrationMode,
  getRegistrationPolicy,
  type RegistrationSettings,
} from '@/lib/account-policy';
import { AdminConfig } from '@/lib/admin.types';
import { getAuthInfoFromBrowserCookie } from '@/lib/auth';
import { notifyRegistrationPolicyChanged } from '@/lib/registration-policy-events';

import { createPortal } from '@/components/admin/AdminPortal';
import { TVBoxTokenModal } from '@/components/TVBoxTokenManager';
import UserApprovalModal from '@/components/UserApprovalModal';

import { AdminEmptyState, AdminSection, AdminTabs } from './AdminPrimitives';
import {
  AlertModal,
  buttonStyles,
  showError,
  showSuccess,
  useAlertModal,
  useLoadingState,
} from './shared';
import { UserActionDrawer } from './UserActionDrawer';
import { UserDrawerOverview } from './UserDrawerOverview';

interface UserConfigProps {
  config: AdminConfig | null;
  role: 'owner' | 'admin' | null;
  refreshConfig: () => Promise<void>;
}

type AdminUserIdentity = AdminConfig['UserConfig']['Users'][number] & {
  uid?: string;
};

type UserDrawerView =
  | 'overview'
  | 'rename'
  | 'password'
  | 'groups'
  | 'sources'
  | 'tvbox'
  | 'delete'
  | 'reject';

const drawerTitles: Record<UserDrawerView, string> = {
  overview: '用户详情',
  rename: '修改用户名',
  password: '修改密码',
  groups: '配置用户组',
  sources: '配置采集源权限',
  tvbox: '配置 TVBox',
  delete: '删除用户',
  reject: '拒绝申请',
};

const drawerSubmitLabels: Partial<Record<UserDrawerView, string>> = {
  rename: '保存用户名',
  password: '保存密码',
  groups: '保存用户组',
  sources: '保存权限',
  delete: '确认删除',
  reject: '确认拒绝',
};

const UserConfig = ({ config, role, refreshConfig }: UserConfigProps) => {
  const router = useRouter();
  const { alertModal, showAlert, hideAlert } = useAlertModal();
  const { isLoading, withLoading } = useLoadingState();
  const [view, setView] = useState<'users' | 'groups' | 'registration'>(
    'users',
  );
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const registrationWriteInFlight = useRef(false);

  // 待审核用户列表
  const pendingUsers = useMemo(() => {
    return (
      config?.UserConfig?.Users?.filter((u) => u.pending).map((u) => ({
        uid: (u as AdminUserIdentity).uid,
        username: u.username,
        email: u.email,
        source: u.source,
        createdAt: u.createdAt,
        pending: u.pending,
      })) || []
    );
  }, [config?.UserConfig?.Users]);

  const updateRegistrationSetting = async (
    key: keyof RegistrationSettings,
    enabled: boolean,
    label: string,
  ) => {
    if (registrationWriteInFlight.current) return;
    registrationWriteInFlight.current = true;
    try {
      await withLoading('registrationSettings', async () => {
        try {
          const response = await fetch('/api/admin/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: enabled }),
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || '更新注册设置失败');
          }
          notifyRegistrationPolicyChanged();
          await refreshConfig();
          showAlert({
            type: 'success',
            title: '设置已更新',
            message: `${label}已${enabled ? '开启' : '关闭'}`,
            timer: 2000,
          });
        } catch (err) {
          showError(err instanceof Error ? err.message : '操作失败', showAlert);
        }
      });
    } finally {
      registrationWriteInFlight.current = false;
    }
  };

  // 审核用户
  const handleApproveUser = async (uid: string) => {
    const user = pendingUsers.find((entry) => entry.uid === uid);
    if (!user?.uid) {
      showError('无法找到待审核账号，请刷新用户列表后重试。', showAlert);
      return;
    }
    await withLoading(`approve_${uid}`, async () => {
      try {
        const res = await fetch('/api/admin/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', targetUid: uid }),
        });
        if (!res.ok) throw new Error('审核失败');
        await refreshConfig();
        showAlert({
          type: 'success',
          title: '已通过审核',
          message: `用户 ${user.username} 已通过审核`,
          timer: 2000,
        });
      } catch {
        showAlert({
          type: 'error',
          title: '审核失败',
          message: '操作失败，请重试',
        });
      }
    });
  };

  const handleRejectUser = async (uid: string, reason?: string) => {
    const user = pendingUsers.find((entry) => entry.uid === uid);
    if (!user?.uid) {
      showError('无法找到待审核账号，请刷新用户列表后重试。', showAlert);
      return;
    }
    await withLoading(`reject_${uid}`, async () => {
      try {
        const res = await fetch('/api/admin/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'reject',
            targetUid: uid,
            reason,
          }),
        });
        if (!res.ok) throw new Error('拒绝失败');
        await refreshConfig();
        showAlert({
          type: 'success',
          title: '已拒绝申请',
          message: `已拒绝用户 ${user.username} 的申请`,
          timer: 2000,
        });
      } catch {
        showAlert({
          type: 'error',
          title: '拒绝失败',
          message: '操作失败，请重试',
        });
      }
    });
  };
  const [showAddUserForm, setShowAddUserForm] = useState(false);
  const [drawerUserUid, setDrawerUserUid] = useState<string | null>(null);
  const [drawerView, setDrawerView] = useState<UserDrawerView>('overview');
  const [rejectionReason, setRejectionReason] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');
  const [tvboxBusy, setTVBoxBusy] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const userSearchRef = useRef<HTMLInputElement | null>(null);
  const drawerContentRef = useRef<HTMLDivElement | null>(null);
  const [showAddUserGroupForm, setShowAddUserGroupForm] = useState(false);
  const [showEditUserGroupForm, setShowEditUserGroupForm] = useState(false);
  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    userGroup: '', // 新增用户组字段
  });
  const [changePasswordUser, setChangePasswordUser] = useState({
    uid: '',
    username: '',
    password: '',
  });
  const [renamingUser, setRenamingUser] = useState<AdminUserIdentity | null>(
    null,
  );
  const [newUsername, setNewUsername] = useState('');
  const [renameError, setRenameError] = useState('');
  const [isRenamingUser, setIsRenamingUser] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameRequestPending = useRef(false);
  const [newUserGroup, setNewUserGroup] = useState({
    name: '',
    enabledApis: [] as string[],
    showAdultContent: false,
  });
  const [editingUserGroup, setEditingUserGroup] = useState<{
    name: string;
    enabledApis: string[];
    showAdultContent?: boolean;
  } | null>(null);
  const [selectedUser, setSelectedUser] = useState<{
    uid?: string;
    username: string;
    role: 'user' | 'admin' | 'owner';
    enabledApis?: string[];
    tags?: string[];
    showAdultContent?: boolean;
  } | null>(null);
  const [selectedApis, setSelectedApis] = useState<string[]>([]);
  const [selectedShowAdultContent, setSelectedShowAdultContent] = useState<
    boolean | undefined
  >(undefined);
  const [selectedUserForGroup, setSelectedUserForGroup] = useState<{
    uid?: string;
    username: string;
    role: 'user' | 'admin' | 'owner';
    tags?: string[];
  } | null>(null);
  const [selectedUserGroups, setSelectedUserGroups] = useState<string[]>([]);
  // Selected accounts are stored by immutable UID, independent of login names.
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [showBatchUserGroupModal, setShowBatchUserGroupModal] = useState(false);
  const [selectedUserGroup, setSelectedUserGroup] = useState<string>('');
  const [showDeleteUserGroupModal, setShowDeleteUserGroupModal] =
    useState(false);
  const [deletingUserGroup, setDeletingUserGroup] = useState<{
    name: string;
    affectedUsers: Array<{
      username: string;
      role: 'user' | 'admin' | 'owner';
    }>;
  } | null>(null);
  const [deletingUser, setDeletingUser] = useState<Pick<
    AdminUserIdentity,
    'uid' | 'username'
  > | null>(null);

  // 用户组筛选状态
  const [filterUserGroup, setFilterUserGroup] = useState<string>('all');
  // ID、用户名或邮箱搜索状态
  const [filterUsername, setFilterUsername] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // 当前登录用户名
  const authInfo = getAuthInfoFromBrowserCookie();
  const currentUsername = authInfo?.username || null;
  const currentUserUid = authInfo?.uid || null;
  const isCurrentUser = useCallback(
    (user: AdminUserIdentity) =>
      currentUserUid
        ? user.uid === currentUserUid
        : user.username === currentUsername,
    [currentUserUid, currentUsername],
  );

  const drawerUser = config?.UserConfig.Users.find(
    (user) => user.uid === drawerUserUid,
  );
  const canManageDrawerUser = Boolean(
    drawerUser?.uid &&
    (role === 'owner' ||
      (role === 'admin' &&
        (drawerUser.role === 'user' || isCurrentUser(drawerUser)))),
  );
  const canEditDrawerCredentials =
    canManageDrawerUser && drawerUser?.role !== 'owner';
  const canModerateDrawerUser = Boolean(
    canManageDrawerUser &&
    drawerUser &&
    drawerUser.role !== 'owner' &&
    !isCurrentUser(drawerUser),
  );
  const drawerBusy =
    isRenamingUser ||
    tvboxBusy ||
    [
      'approve',
      'reject',
      'changePassword',
      'saveUserGroups',
      'assignUserGroup',
      'saveUserApis',
      'banUser',
      'unbanUser',
      'setAdmin',
      'removeAdmin',
      'deleteUser',
    ].some((action) => isLoading(action + '_' + drawerUserUid));

  const resetDrawerEditor = useCallback(() => {
    setDrawerView('overview');
    setRenamingUser(null);
    setNewUsername('');
    setRenameError('');
    setChangePasswordUser({ uid: '', username: '', password: '' });
    setSelectedUser(null);
    setSelectedApis([]);
    setSelectedShowAdultContent(undefined);
    setSourceSearch('');
    setSelectedUserForGroup(null);
    setSelectedUserGroups([]);
    setDeletingUser(null);
    setRejectionReason('');
    setTVBoxBusy(false);
  }, []);

  const closeUserDrawer = () => {
    if (drawerBusy || renameRequestPending.current) return;
    setDrawerUserUid(null);
    resetDrawerEditor();
  };

  const openUserDrawer = (
    user: AdminUserIdentity,
    trigger: HTMLButtonElement,
  ) => {
    if (!user.uid || drawerBusy) return;
    drawerTriggerRef.current = trigger;
    resetDrawerEditor();
    setDrawerUserUid(user.uid);
  };

  const returnToUserDetails = () => {
    if (drawerBusy || renameRequestPending.current) return;
    resetDrawerEditor();
  };

  // Clear a removed identity before rendering, even if a login name is reused.
  if (drawerUserUid && config && !drawerUser) {
    setDrawerUserUid(null);
    resetDrawerEditor();
  }

  useEffect(() => {
    if (!drawerUserUid) return;
    const content = drawerContentRef.current;
    content?.closest('.admin-user-drawer-body')?.scrollTo({ top: 0 });
    content
      ?.querySelector<HTMLElement>('[data-drawer-autofocus]')
      ?.focus({ preventScroll: true });
  }, [drawerView, drawerUserUid]);

  useEffect(() => {
    if (renamingUser) renameInputRef.current?.focus();
  }, [renamingUser]);

  const visibleUsers = useMemo<AdminUserIdentity[]>(() => {
    const query = filterUsername.trim().toLowerCase();
    return [...(config?.UserConfig?.Users || [])]
      .filter((user) => {
        if (
          query &&
          user.uid !== query &&
          !user.username.toLowerCase().includes(query) &&
          !user.email?.trim().toLowerCase().includes(query)
        )
          return false;
        if (filterStatus === 'active' && (user.banned || user.pending))
          return false;
        if (filterStatus === 'pending' && !user.pending) return false;
        if (filterStatus === 'banned' && !user.banned) return false;
        if (filterUserGroup === 'none') return !user.tags?.length;
        return (
          filterUserGroup === 'all' || user.tags?.includes(filterUserGroup)
        );
      })
      .sort((a, b) => {
        const priority = (user: typeof a) => {
          if (isCurrentUser(user)) return 0;
          if (user.role === 'owner') return 1;
          if (user.role === 'admin') return 2;
          return 3;
        };
        return priority(a) - priority(b);
      });
  }, [
    config?.UserConfig?.Users,
    isCurrentUser,
    filterStatus,
    filterUserGroup,
    filterUsername,
  ]);

  const selectableUserIds = useMemo(
    () =>
      visibleUsers
        .filter((user) => Boolean(user.uid))
        .filter(
          (user) =>
            role === 'owner' ||
            (role === 'admin' && (user.role === 'user' || isCurrentUser(user))),
        )
        .map((user) => user.uid as string),
    [visibleUsers, role, isCurrentUser],
  );
  const selectAllUsers =
    selectableUserIds.length > 0 &&
    selectableUserIds.every((uid) => selectedUsers.has(uid));

  // 获取用户组列表
  const userGroups = config?.UserConfig?.Tags || [];

  // 处理用户组相关操作
  const handleUserGroupAction = async (
    action: 'add' | 'edit' | 'delete',
    groupName: string,
    enabledApis?: string[],
    showAdultContent?: boolean,
  ) => {
    return withLoading(`userGroup_${action}_${groupName}`, async () => {
      try {
        const res = await fetch('/api/admin/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'userGroup',
            groupAction: action,
            groupName,
            enabledApis,
            showAdultContent,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `操作失败: ${res.status}`);
        }

        await refreshConfig();

        if (action === 'add') {
          setNewUserGroup({
            name: '',
            enabledApis: [],
            showAdultContent: false,
          });
          setShowAddUserGroupForm(false);
        } else if (action === 'edit') {
          setEditingUserGroup(null);
          setShowEditUserGroupForm(false);
        }

        showSuccess(
          action === 'add'
            ? '用户组添加成功'
            : action === 'edit'
              ? '用户组更新成功'
              : '用户组删除成功',
          showAlert,
        );
      } catch (err) {
        showError(err instanceof Error ? err.message : '操作失败', showAlert);
        throw err;
      }
    });
  };

  const handleAddUserGroup = () => {
    if (!newUserGroup.name.trim()) return;
    handleUserGroupAction(
      'add',
      newUserGroup.name,
      newUserGroup.enabledApis,
      newUserGroup.showAdultContent,
    );
  };

  const handleEditUserGroup = () => {
    if (!editingUserGroup?.name.trim()) return;
    handleUserGroupAction(
      'edit',
      editingUserGroup.name,
      editingUserGroup.enabledApis,
      editingUserGroup.showAdultContent,
    );
  };

  const handleDeleteUserGroup = (groupName: string) => {
    // 计算会受影响的用户数量
    const affectedUsers =
      config?.UserConfig?.Users?.filter(
        (user) => user.tags && user.tags.includes(groupName),
      ) || [];

    setDeletingUserGroup({
      name: groupName,
      affectedUsers: affectedUsers.map((u) => ({
        username: u.username,
        role: u.role,
      })),
    });
    setShowDeleteUserGroupModal(true);
  };

  const handleConfirmDeleteUserGroup = async () => {
    if (!deletingUserGroup) return;

    try {
      await handleUserGroupAction('delete', deletingUserGroup.name);
      setShowDeleteUserGroupModal(false);
      setDeletingUserGroup(null);
    } catch {
      // 错误处理已在 handleUserGroupAction 中处理
    }
  };

  const handleStartEditUserGroup = (group: {
    name: string;
    enabledApis: string[];
  }) => {
    setEditingUserGroup({ ...group });
    setShowEditUserGroupForm(true);
    setShowAddUserGroupForm(false);
  };

  // 为用户分配用户组
  const handleAssignUserGroup = async (uid: string, userGroups: string[]) => {
    return withLoading(`assignUserGroup_${uid}`, async () => {
      try {
        const res = await fetch('/api/admin/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUid: uid,
            action: 'updateUserGroups',
            userGroups,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `操作失败: ${res.status}`);
        }

        await refreshConfig();
        showSuccess('用户组分配成功', showAlert);
      } catch (err) {
        showError(err instanceof Error ? err.message : '操作失败', showAlert);
        throw err;
      }
    });
  };

  const handleBanUser = async (uid: string | undefined) => {
    await withLoading(`banUser_${uid}`, () => handleUserAction('ban', uid));
  };

  const handleUnbanUser = async (uid: string | undefined) => {
    await withLoading(`unbanUser_${uid}`, () => handleUserAction('unban', uid));
  };

  const handleSetAdmin = async (uid: string | undefined) => {
    await withLoading(`setAdmin_${uid}`, () =>
      handleUserAction('setAdmin', uid),
    );
  };

  const handleRemoveAdmin = async (uid: string | undefined) => {
    await withLoading(`removeAdmin_${uid}`, () =>
      handleUserAction('cancelAdmin', uid),
    );
  };

  const handleAddUser = async () => {
    if (!newUser.username || !newUser.password) return;
    await withLoading('addUser', async () => {
      await handleUserAction(
        'add',
        newUser.username,
        newUser.password,
        newUser.userGroup,
      );
      setNewUser({ username: '', password: '', userGroup: '' });
      setShowAddUserForm(false);
    });
  };

  const handleChangePassword = async () => {
    if (!changePasswordUser.uid || !changePasswordUser.password) return;
    await withLoading(`changePassword_${changePasswordUser.uid}`, async () => {
      await handleUserAction(
        'changePassword',
        changePasswordUser.uid,
        changePasswordUser.password,
      );
      setChangePasswordUser({ uid: '', username: '', password: '' });
      setDrawerView('overview');
    });
  };

  const handleShowChangePasswordForm = (user: AdminUserIdentity) => {
    if (!user.uid) return;
    setChangePasswordUser({
      uid: user.uid,
      username: user.username,
      password: '',
    });
    setDrawerView('password');
    setShowAddUserForm(false); // 关闭添加用户表单
  };

  const canChangeUsername = (user: AdminUserIdentity) =>
    user.role !== 'owner' &&
    (role === 'owner' ||
      (role === 'admin' && (user.role === 'user' || isCurrentUser(user))));

  const handleStartRenameUser = (user: AdminUserIdentity) => {
    if (!canChangeUsername(user) || !user.uid || renameRequestPending.current)
      return;
    setRenamingUser(user);
    setNewUsername(user.username);
    setRenameError('');
    setDrawerView('rename');
  };

  const handleChangeUsername = async () => {
    if (!renamingUser || renameRequestPending.current) return;
    const targetUser = config?.UserConfig.Users.find(
      (user) => user.uid === renamingUser.uid,
    );
    const username = newUsername.trim();

    if (!targetUser?.uid || !canChangeUsername(targetUser)) {
      setRenameError('当前账号无法修改用户名，请刷新用户列表后重试。');
      return;
    }
    if (!username) {
      setRenameError('请输入新用户名。');
      return;
    }
    if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,20}$/.test(username)) {
      setRenameError(
        '用户名只能包含汉字、字母、数字和下划线，长度为 2–20 位。',
      );
      return;
    }
    if (username === targetUser.username) {
      setRenameError('新用户名需要与当前用户名不同。');
      return;
    }

    renameRequestPending.current = true;
    setIsRenamingUser(true);
    setRenameError('');
    try {
      const response = await fetch('/api/admin/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'changeUsername',
          targetUid: targetUser.uid,
          newUsername: username,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) {
        throw new Error(
          typeof result?.error === 'string'
            ? result.error
            : '修改用户名失败，请重试。',
        );
      }

      if (result.requiresRelogin === true) {
        setRenamingUser(null);
        setNewUsername('');
        setDrawerUserUid(null);
        router.replace('/login');
        return;
      }

      // The account UID and its selection remain stable when its login name changes.
      setChangePasswordUser((previous) =>
        previous.uid === targetUser.uid ? { ...previous, username } : previous,
      );
      setFilterUsername((previous) =>
        previous.trim().toLowerCase() === targetUser.username.toLowerCase()
          ? username
          : previous,
      );
      setRenamingUser(null);
      setNewUsername('');
      setDrawerView('overview');
      try {
        await refreshConfig();
        showSuccess(
          `用户名已修改为 ${username}，该账号需要重新登录。`,
          showAlert,
        );
      } catch {
        showAlert({
          type: 'warning',
          title: '用户名已修改',
          message:
            '用户列表刷新失败，请刷新页面。该账号需要使用新用户名重新登录。',
        });
      }
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : '修改用户名失败，请重试。',
      );
    } finally {
      renameRequestPending.current = false;
      setIsRenamingUser(false);
    }
  };

  const handleDeleteUser = (user: AdminUserIdentity) => {
    if (!user.uid) return;
    setDeletingUser({ uid: user.uid, username: user.username });
    setDrawerView('delete');
  };

  const handleConfigureUserApis = (user: AdminUserIdentity) => {
    if (!user.uid) return;
    setSelectedUser(user);
    // Preserve the personal override; an empty selection inherits group/site rules.
    setSelectedApis(user.enabledApis || []);
    setSelectedShowAdultContent(user.showAdultContent);
    setSourceSearch('');
    setDrawerView('sources');
  };

  const handleConfigureUserGroup = (user: AdminUserIdentity) => {
    if (!user.uid) return;
    setSelectedUserForGroup(user);
    setSelectedUserGroups(user.tags || []);
    setDrawerView('groups');
  };

  const handleSaveUserGroups = async () => {
    if (!selectedUserForGroup?.uid) return;
    const targetUid = selectedUserForGroup.uid;

    await withLoading(
      `saveUserGroups_${selectedUserForGroup.uid}`,
      async () => {
        try {
          await handleAssignUserGroup(targetUid, selectedUserGroups);
          setDrawerView('overview');
          setSelectedUserForGroup(null);
          setSelectedUserGroups([]);
        } catch {
          // 错误处理已在 handleAssignUserGroup 中处理
        }
      },
    );
  };

  // 处理用户选择
  const handleSelectUser = useCallback((uid: string, checked: boolean) => {
    setSelectedUsers((prev) => {
      const newSelectedUsers = new Set(prev);
      if (checked) {
        newSelectedUsers.add(uid);
      } else {
        newSelectedUsers.delete(uid);
      }
      return newSelectedUsers;
    });
  }, []);

  const handleSelectAllUsers = useCallback(
    (checked: boolean) => {
      setSelectedUsers((previous) => {
        const next = new Set(previous);
        selectableUserIds.forEach((uid) => {
          if (checked) next.add(uid);
          else next.delete(uid);
        });
        return next;
      });
    },
    [selectableUserIds],
  );

  // 批量设置用户组
  const handleBatchSetUserGroup = async (userGroup: string) => {
    if (selectedUsers.size === 0) return;

    await withLoading('batchSetUserGroup', async () => {
      try {
        const res = await fetch('/api/admin/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'batchUpdateUserGroups',
            userUids: Array.from(selectedUsers),
            userGroups: userGroup === '' ? [] : [userGroup],
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `操作失败: ${res.status}`);
        }

        const userCount = selectedUsers.size;
        setSelectedUsers(new Set());
        setShowBatchUserGroupModal(false);
        setSelectedUserGroup('');
        showSuccess(
          `已为 ${userCount} 个用户设置用户组: ${userGroup}`,
          showAlert,
        );

        // 刷新配置
        await refreshConfig();
      } catch (err) {
        showError('批量设置用户组失败', showAlert);
        throw err;
      }
    });
  };

  // 提取URL域名的辅助函数
  const extractDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      // 如果URL格式不正确，返回原字符串
      return url;
    }
  };

  const handleSaveUserApis = async () => {
    if (!selectedUser?.uid) return;
    const targetUid = selectedUser.uid;

    await withLoading(`saveUserApis_${selectedUser.uid}`, async () => {
      try {
        const res = await fetch('/api/admin/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUid,
            action: 'updateUserApis',
            enabledApis: selectedApis,
            showAdultContent: selectedShowAdultContent,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `操作失败: ${res.status}`);
        }

        // 成功后刷新配置
        await refreshConfig();
        setDrawerView('overview');
        setSelectedUser(null);
        setSelectedApis([]);
        setSelectedShowAdultContent(false);
        showSuccess('采集源权限已更新', showAlert);
      } catch (err) {
        showError(err instanceof Error ? err.message : '操作失败', showAlert);
        throw err;
      }
    });
  };

  // 通用请求函数
  const handleUserAction = async (
    action:
      | 'add'
      | 'ban'
      | 'unban'
      | 'setAdmin'
      | 'cancelAdmin'
      | 'changePassword'
      | 'deleteUser',
    targetIdentifier: string | undefined,
    targetPassword?: string,
    userGroup?: string,
    options?: { skipToast?: boolean }, // 新增：支持跳过通知
  ) => {
    try {
      if (!targetIdentifier)
        throw new Error('账户信息尚未准备好，请刷新后重试。');
      const res = await fetch('/api/admin/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(action === 'add'
            ? { targetUsername: targetIdentifier }
            : { targetUid: targetIdentifier }),
          ...(targetPassword ? { targetPassword } : {}),
          ...(userGroup ? { userGroup } : {}),
          action,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `操作失败: ${res.status}`);
      }

      // 成功后刷新配置（无需整页刷新）
      await refreshConfig();

      // 根据操作类型决定是否显示通知
      // 频繁的切换操作（启用/禁用）默认不显示通知，除非明确要求
      const silentActions = ['ban', 'unban']; // 频繁操作，默认静默
      const shouldShowToast =
        options?.skipToast === false || !silentActions.includes(action);

      if (shouldShowToast) {
        const actionMessages: Record<string, string> = {
          add: '用户添加成功',
          ban: '用户已禁用',
          unban: '用户已启用',
          setAdmin: '已设置为管理员',
          cancelAdmin: '已取消管理员权限',
          changePassword: '密码修改成功',
          deleteUser: '用户删除成功',
        };
        showSuccess(actionMessages[action] || '操作成功', showAlert);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : '操作失败', showAlert);
      throw err;
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!deletingUser?.uid) return;

    setDrawerView('overview');
    const { username: usernameToDelete, uid: uidToDelete } = deletingUser;
    setDeletingUser(null);

    // 使用撤销模式：显示带撤销按钮的通知
    let undoCancelled = false;

    showAlert({
      type: 'warning',
      title: '用户删除中',
      message: `用户 ${usernameToDelete} 将被删除，点击撤销可取消操作`,
      showUndo: true,
      undoTimer: 5000,
      onUndo: () => {
        undoCancelled = true;
        showSuccess('已取消删除操作', showAlert);
      },
    });

    // 5秒后执行真正的删除
    setTimeout(async () => {
      if (!undoCancelled) {
        await withLoading(`deleteUser_${uidToDelete}`, async () => {
          try {
            await handleUserAction(
              'deleteUser',
              uidToDelete,
              undefined,
              undefined,
              { skipToast: true },
            );
            showSuccess(`用户 ${usernameToDelete} 已删除`, showAlert);
          } catch {
            // 错误处理已在 handleUserAction 中处理
          }
        });
      }
    }, 5000);
  };

  const openDrawerEditor = (
    next: 'rename' | 'password' | 'groups' | 'sources' | 'tvbox',
  ) => {
    if (!drawerUser || !canManageDrawerUser || drawerBusy) return;
    if ((next === 'rename' || next === 'password') && !canEditDrawerCredentials)
      return;
    resetDrawerEditor();
    if (next === 'rename') handleStartRenameUser(drawerUser);
    else if (next === 'password') handleShowChangePasswordForm(drawerUser);
    else if (next === 'groups') handleConfigureUserGroup(drawerUser);
    else if (next === 'sources') handleConfigureUserApis(drawerUser);
    else setDrawerView('tvbox');
  };

  const submitDrawerEditor = async () => {
    if (!drawerUser?.uid || drawerBusy) return;
    if (
      (drawerView === 'rename' || drawerView === 'password') &&
      !canEditDrawerCredentials
    )
      return;
    if (
      (drawerView === 'groups' || drawerView === 'sources') &&
      !canManageDrawerUser
    )
      return;
    if (
      (drawerView === 'delete' || drawerView === 'reject') &&
      !canModerateDrawerUser
    )
      return;
    try {
      if (drawerView === 'rename') await handleChangeUsername();
      else if (drawerView === 'password') await handleChangePassword();
      else if (drawerView === 'groups') await handleSaveUserGroups();
      else if (drawerView === 'sources') await handleSaveUserApis();
      else if (drawerView === 'delete') await handleConfirmDeleteUser();
      else if (drawerView === 'reject')
        await handleRejectUser(
          drawerUser.uid,
          rejectionReason.trim() || undefined,
        );
    } catch {
      // Each request handler keeps its form open and shows the error feedback.
    }
  };

  const runDrawerAction = (action: () => Promise<void>) => {
    if (drawerBusy) return;
    void action().catch(() => {
      // Feedback is already presented by the shared request handler.
    });
  };

  if (!config) {
    return (
      <div className='flex justify-center items-center py-8' role='status'>
        <div className='flex items-center gap-3 text-gray-500'>
          <div className='animate-spin rounded-full h-5 w-5 border-2 border-blue-300 border-t-blue-600 dark:border-blue-700 dark:border-t-blue-400'></div>
          <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
            加载配置中...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className='admin-module min-w-0'>
      <AdminTabs
        label='用户管理视图'
        value={view}
        onChange={setView}
        items={[
          {
            id: 'users',
            label: '用户列表',
            count: config.UserConfig.Users.length,
          },
          { id: 'groups', label: '用户组', count: userGroups.length },
          ...(role === 'owner'
            ? [
                {
                  id: 'registration' as const,
                  label: '注册与审核',
                  count: pendingUsers.length,
                },
              ]
            : []),
        ]}
      />

      {view === 'users' && (
        <div className='admin-module admin-stack'>
          <dl className='admin-summary-strip'>
            <div className='admin-summary-item'>
              <dt>全部用户</dt>
              <dd>{config.UserConfig.Users.length}</dd>
            </div>
            <div className='admin-summary-item'>
              <dt>正常使用</dt>
              <dd>
                {
                  config.UserConfig.Users.filter(
                    (user) => !user.banned && !user.pending,
                  ).length
                }
              </dd>
            </div>
            <div className='admin-summary-item'>
              <dt>待审核</dt>
              <dd>{pendingUsers.length}</dd>
            </div>
            <div className='admin-summary-item'>
              <dt>已封禁</dt>
              <dd>
                {config.UserConfig.Users.filter((user) => user.banned).length}
              </dd>
            </div>
          </dl>
          <AdminSection
            title='用户列表'
            description='管理账户、用户组和访问权限。'
            action={
              <div className='flex flex-wrap items-center gap-2'>
                {role === 'owner' && pendingUsers.length > 0 && (
                  <button
                    type='button'
                    onClick={() => setShowApprovalModal(true)}
                    className={buttonStyles.secondary}
                  >
                    <Clock size={15} aria-hidden='true' /> 待审核{' '}
                    {pendingUsers.length}
                  </button>
                )}
                <button
                  type='button'
                  onClick={() => {
                    setShowAddUserForm(!showAddUserForm);
                  }}
                  className={
                    showAddUserForm
                      ? buttonStyles.secondary
                      : buttonStyles.primary
                  }
                  aria-expanded={showAddUserForm}
                  aria-controls='admin-add-user-form'
                >
                  {showAddUserForm ? (
                    <X size={16} aria-hidden='true' />
                  ) : (
                    <Plus size={16} aria-hidden='true' />
                  )}
                  {showAddUserForm ? '收起表单' : '添加用户'}
                </button>
              </div>
            }
          >
            <div className='admin-toolbar'>
              <div className='admin-filters'>
                <label className='flex min-w-0 items-center gap-2'>
                  <Search
                    size={16}
                    className='shrink-0 text-gray-400'
                    aria-hidden='true'
                  />
                  <span className='sr-only'>搜索 ID、用户名或邮箱</span>
                  <input
                    ref={userSearchRef}
                    type='search'
                    value={filterUsername}
                    onChange={(e) => setFilterUsername(e.target.value)}
                    placeholder='搜索 ID、用户名或邮箱'
                    className='min-w-0 w-full sm:w-60'
                  />
                </label>
                <select
                  aria-label='按状态筛选用户'
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                >
                  <option value='all'>全部状态</option>
                  <option value='active'>正常使用</option>
                  <option value='pending'>待审核</option>
                  <option value='banned'>已封禁</option>
                </select>
                <select
                  aria-label='按用户组筛选用户'
                  value={filterUserGroup}
                  onChange={(e) => setFilterUserGroup(e.target.value)}
                >
                  <option value='all'>全部用户组</option>
                  <option value='none'>无用户组</option>
                  {userGroups.map((group) => (
                    <option key={group.name} value={group.name}>
                      {group.name}
                    </option>
                  ))}
                </select>
                {(filterUsername ||
                  filterStatus !== 'all' ||
                  filterUserGroup !== 'all') && (
                  <button
                    type='button'
                    className={buttonStyles.secondarySmall}
                    onClick={() => {
                      setFilterUsername('');
                      setFilterStatus('all');
                      setFilterUserGroup('all');
                    }}
                  >
                    重置筛选
                  </button>
                )}
              </div>
            </div>
            {showAddUserForm && (
              <div
                id='admin-add-user-form'
                className='my-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900'
                role='region'
                aria-labelledby='admin-add-user-title'
              >
                <h3
                  id='admin-add-user-title'
                  className='mb-4 text-sm font-semibold text-gray-900 dark:text-gray-100'
                >
                  添加用户
                </h3>
                <div className='grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3'>
                  <label className='min-w-0 space-y-2'>
                    <span className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
                      用户名
                    </span>
                    <input
                      type='text'
                      placeholder='输入用户名'
                      value={newUser.username}
                      onChange={(e) =>
                        setNewUser((prev) => ({
                          ...prev,
                          username: e.target.value,
                        }))
                      }
                      className='w-full min-w-0'
                    />
                  </label>
                  <label className='min-w-0 space-y-2'>
                    <span className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
                      初始密码
                    </span>
                    <input
                      type='password'
                      placeholder='设置初始密码'
                      autoComplete='new-password'
                      value={newUser.password}
                      onChange={(e) =>
                        setNewUser((prev) => ({
                          ...prev,
                          password: e.target.value,
                        }))
                      }
                      className='w-full min-w-0'
                    />
                  </label>
                  <label className='min-w-0 space-y-2'>
                    <span className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
                      用户组{' '}
                      <span className='font-normal text-gray-500'>
                        （可选）
                      </span>
                    </span>
                    <select
                      value={newUser.userGroup}
                      onChange={(e) =>
                        setNewUser((prev) => ({
                          ...prev,
                          userGroup: e.target.value,
                        }))
                      }
                      className='w-full min-w-0'
                    >
                      <option value=''>无用户组（无限制）</option>
                      {userGroups.map((group) => (
                        <option key={group.name} value={group.name}>
                          {group.name}（
                          {group.enabledApis?.length
                            ? `${group.enabledApis.length} 个源`
                            : '无限制'}
                          ）
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className='mt-4 flex justify-end'>
                  <button
                    type='button'
                    onClick={handleAddUser}
                    disabled={
                      !newUser.username ||
                      !newUser.password ||
                      isLoading('addUser')
                    }
                    className={
                      !newUser.username ||
                      !newUser.password ||
                      isLoading('addUser')
                        ? buttonStyles.disabled
                        : buttonStyles.primary
                    }
                  >
                    {isLoading('addUser') ? '添加中…' : '确认添加'}
                  </button>
                </div>
              </div>
            )}

            <div className='admin-toolbar my-3'>
              <p className='admin-muted' aria-live='polite'>
                {selectedUsers.size > 0
                  ? `已选择 ${selectedUsers.size} 位用户`
                  : '勾选用户后可批量分配用户组'}
              </p>
              <div className='flex flex-wrap items-center gap-2'>
                {selectedUsers.size > 0 && (
                  <button
                    type='button'
                    onClick={() => setSelectedUsers(new Set())}
                    className={buttonStyles.secondarySmall}
                  >
                    清除选择
                  </button>
                )}
                <button
                  type='button'
                  onClick={() => setShowBatchUserGroupModal(true)}
                  disabled={selectedUsers.size === 0}
                  className={
                    selectedUsers.size === 0
                      ? buttonStyles.disabledSmall
                      : buttonStyles.primarySmall
                  }
                >
                  批量设置用户组
                </button>
              </div>
            </div>
            {/* 用户列表 */}
            <div
              className='admin-table-wrap relative max-h-[34rem] overflow-auto'
              data-table='user-list'
            >
              <table className='admin-table min-w-[720px]'>
                <thead className='sticky top-0 z-10'>
                  <tr>
                    <th scope='col' className='w-10 text-center'>
                      <input
                        type='checkbox'
                        aria-label='选择当前筛选结果中的全部可管理用户'
                        checked={selectAllUsers}
                        disabled={selectableUserIds.length === 0}
                        onChange={(event) =>
                          handleSelectAllUsers(event.target.checked)
                        }
                        className='h-4 w-4'
                      />
                    </th>
                    <th scope='col' className='w-16'>
                      ID
                    </th>
                    <th scope='col'>用户名</th>
                    <th scope='col'>角色</th>
                    <th scope='col'>状态</th>
                    <th scope='col'>用户组</th>
                    <th scope='col' className='w-24 text-right'>
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((user) => (
                    <tr key={user.uid || 'unassigned-' + user.username}>
                      <td className='w-10 text-center'>
                        {(role === 'owner' ||
                          (role === 'admin' &&
                            (user.role === 'user' || isCurrentUser(user)))) && (
                          <input
                            type='checkbox'
                            aria-label={'选择用户 ' + user.username}
                            checked={Boolean(
                              user.uid && selectedUsers.has(user.uid),
                            )}
                            disabled={!user.uid}
                            onChange={(event) =>
                              user.uid &&
                              handleSelectUser(user.uid, event.target.checked)
                            }
                            className='h-4 w-4'
                          />
                        )}
                      </td>
                      <td className='w-16 whitespace-nowrap'>
                        <span className='select-all tabular-nums'>
                          {user.uid || '—'}
                        </span>
                      </td>
                      <td>
                        <div className='flex items-center gap-2 font-medium'>
                          {user.username}
                          {isCurrentUser(user) && (
                            <span className='admin-tag'>当前</span>
                          )}
                        </div>
                        <p className='admin-table-meta max-w-64 whitespace-normal break-all font-normal'>
                          {user.email?.trim() || 'null'}
                        </p>
                      </td>
                      <td>
                        <span
                          className='admin-user-badge'
                          data-tone={
                            user.role === 'owner' ? 'primary' : 'muted'
                          }
                        >
                          {user.role === 'owner'
                            ? '站长'
                            : user.role === 'admin'
                              ? '管理员'
                              : '普通用户'}
                        </span>
                      </td>
                      <td>
                        <span
                          className='admin-user-badge'
                          data-tone={
                            user.pending
                              ? 'warning'
                              : user.banned
                                ? 'danger'
                                : 'success'
                          }
                        >
                          {user.pending
                            ? '待审核'
                            : user.banned
                              ? '已封禁'
                              : '正常'}
                        </span>
                      </td>
                      <td>
                        <div className='admin-user-table-groups'>
                          {user.tags?.length
                            ? user.tags.join('、')
                            : '无用户组'}
                        </div>
                      </td>
                      <td className='text-right'>
                        <button
                          type='button'
                          aria-label={'操作 ' + user.username}
                          aria-haspopup='dialog'
                          aria-expanded={Boolean(
                            user.uid && drawerUserUid === user.uid,
                          )}
                          disabled={!user.uid}
                          onClick={(event) =>
                            openUserDrawer(user, event.currentTarget)
                          }
                          className='admin-user-row-action'
                        >
                          <MoreHorizontal size={16} aria-hidden='true' />
                          操作
                        </button>
                      </td>
                    </tr>
                  ))}
                  {visibleUsers.length === 0 && (
                    <tr>
                      <td colSpan={7}>
                        <AdminEmptyState
                          title={
                            config.UserConfig.Users.length
                              ? '没有匹配的用户'
                              : '暂无用户'
                          }
                          description={
                            config.UserConfig.Users.length
                              ? '调整 ID、用户名、邮箱、状态或用户组筛选后再试。'
                              : '添加第一个用户，开始管理账户与访问权限。'
                          }
                          icon={Users}
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className='admin-toolbar mt-3'>
              <p className='admin-muted' aria-live='polite'>
                显示 {visibleUsers.length} / {config.UserConfig.Users.length}{' '}
                位用户
              </p>
              <p className='admin-muted'>全选仅作用于当前筛选结果</p>
            </div>
          </AdminSection>
        </div>
      )}

      {view === 'groups' && (
        <AdminSection
          title='用户组'
          description='集中分配采集源与内容权限，同组用户共享访问规则。'
          action={
            <button
              type='button'
              onClick={() => {
                setShowAddUserGroupForm(!showAddUserGroupForm);
                if (showEditUserGroupForm) {
                  setShowEditUserGroupForm(false);
                  setEditingUserGroup(null);
                }
              }}
              className={
                showAddUserGroupForm
                  ? buttonStyles.secondary
                  : buttonStyles.primary
              }
            >
              <Plus size={16} aria-hidden='true' />
              添加用户组
            </button>
          }
        >
          <div className='admin-table-wrap overflow-x-auto'>
            <table className='admin-table min-w-[680px]'>
              <thead>
                <tr>
                  <th scope='col'>用户组名称</th>
                  <th scope='col'>成员</th>
                  <th scope='col'>采集源权限</th>
                  <th scope='col'>成人内容</th>
                  <th scope='col' className='text-right'>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {userGroups.map((group) => (
                  <tr key={group.name}>
                    <td className='font-medium'>{group.name}</td>
                    <td>
                      <button
                        type='button'
                        className='text-blue-700 hover:underline dark:text-blue-300'
                        aria-label={`查看 ${group.name} 的成员`}
                        onClick={() => {
                          setFilterUserGroup(group.name);
                          setFilterUsername('');
                          setFilterStatus('all');
                          setView('users');
                        }}
                      >
                        {
                          config.UserConfig.Users.filter((user) =>
                            user.tags?.includes(group.name),
                          ).length
                        }{' '}
                        位用户
                      </button>
                    </td>
                    <td>
                      {group.enabledApis?.length
                        ? `${group.enabledApis.length} 个源`
                        : '无限制'}
                    </td>
                    <td>
                      <span className='admin-tag'>
                        {group.showAdultContent === undefined
                          ? '跟随站点'
                          : group.showAdultContent
                            ? '允许'
                            : '过滤'}
                      </span>
                    </td>
                    <td className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <button
                          type='button'
                          onClick={() => handleStartEditUserGroup(group)}
                          disabled={isLoading(`userGroup_edit_${group.name}`)}
                          className={buttonStyles.roundedPrimary}
                          aria-label={`编辑用户组 ${group.name}`}
                        >
                          编辑
                        </button>
                        <button
                          type='button'
                          onClick={() => handleDeleteUserGroup(group.name)}
                          className={buttonStyles.roundedDanger}
                          aria-label={`删除用户组 ${group.name}`}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {userGroups.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <AdminEmptyState
                        title='暂无用户组'
                        description='创建用户组，为不同用户分配采集源与访问权限。'
                        icon={Users}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className='admin-muted mt-3'>
            共 {userGroups.length} 个用户组。删除前可查看受影响的成员。
          </p>
        </AdminSection>
      )}

      {view === 'registration' && role === 'owner' && (
        <div className='admin-module admin-stack'>
          {(config.UserConfig.RequireApproval || pendingUsers.length > 0) && (
            <AdminSection
              title='待审核申请'
              description='查看申请资料，通过或拒绝新用户的注册。'
            >
              <div className='admin-toolbar'>
                <div className='flex items-center gap-3'>
                  <Clock
                    size={20}
                    className='text-gray-500'
                    aria-hidden='true'
                  />
                  <p className='text-sm text-gray-600 dark:text-gray-400'>
                    当前有{' '}
                    <strong className='text-gray-900 dark:text-gray-100'>
                      {pendingUsers.length}
                    </strong>{' '}
                    位用户等待审核
                  </p>
                </div>
                <button
                  type='button'
                  onClick={() => setShowApprovalModal(true)}
                  className={buttonStyles.primary}
                >
                  查看待审核申请
                </button>
              </div>
            </AdminSection>
          )}
          <AdminSection
            title='注册规则'
            description='设置保存后立即生效，已打开的注册页面会自动同步。'
          >
            <div className='space-y-4'>
              {(
                [
                  {
                    key: 'AllowRegister',
                    label: '允许用户注册',
                    description:
                      '注册总开关。关闭后，普通注册和第三方账号注册均不可用。',
                    enabled: config.UserConfig.AllowRegister !== false,
                  },
                  {
                    key: 'RequireApproval',
                    label: '需要审核注册',
                    description:
                      '仅未使用邀请码的新用户需要填写邮箱、来源并等待审核；有效邀请码注册免审核。',
                    enabled: config.UserConfig.RequireApproval === true,
                  },
                  {
                    key: 'RequireInviteCode',
                    label: '需要邀请码注册',
                    description:
                      '开启后必须提供有效邀请码，注册后直接登录。关闭后邀请码在审核模式下仍可选填以免审核。',
                    enabled: config.UserConfig.RequireInviteCode === true,
                  },
                ] as const
              ).map((setting, index) => (
                <div
                  key={setting.key}
                  className={
                    index > 0
                      ? 'border-t border-gray-200 pt-4 dark:border-gray-700'
                      : ''
                  }
                >
                  <div className='flex flex-wrap items-start justify-between gap-4'>
                    <div className='min-w-0 flex-1'>
                      <div className='font-medium text-gray-900 dark:text-gray-100'>
                        {setting.label}
                      </div>
                      <p className='text-sm text-gray-600 dark:text-gray-400'>
                        {setting.description}
                      </p>
                    </div>
                    <div className='flex shrink-0 items-center'>
                      <button
                        type='button'
                        role='switch'
                        aria-label={setting.label}
                        aria-checked={setting.enabled}
                        disabled={isLoading('registrationSettings')}
                        onClick={() =>
                          updateRegistrationSetting(
                            setting.key,
                            !setting.enabled,
                            setting.label,
                          )
                        }
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60 ${setting.enabled ? buttonStyles.toggleOn : buttonStyles.toggleOff}`}
                      >
                        <span
                          aria-hidden='true'
                          className={`pointer-events-none inline-block h-5 w-5 rounded-full ${buttonStyles.toggleThumb} shadow transform ring-0 transition duration-200 ease-in-out ${setting.enabled ? buttonStyles.toggleThumbOn : buttonStyles.toggleThumbOff}`}
                        />
                      </button>
                      <span className='ml-3 text-sm font-medium text-gray-900 dark:text-gray-100'>
                        {setting.enabled ? '开启' : '关闭'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
              <div
                role='status'
                className='rounded-lg bg-gray-50 p-4 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-300'
              >
                <p className='font-medium'>
                  当前注册方式：
                  {
                    {
                      closed: '已关闭注册',
                      invite: '邀请码注册，免审核',
                      approval: '普通注册需审核，邀请码注册免审核',
                      open: '开放注册，无需审核',
                    }[
                      getRegistrationMode(
                        getRegistrationPolicy(config.UserConfig),
                      )
                    ]
                  }
                </p>
                <p className='mt-1'>
                  {config.UserConfig.AllowRegister === false
                    ? '审核与邀请码设置已保留，重新开放注册后生效。'
                    : config.UserConfig.RequireInviteCode
                      ? '注册页显示必填邀请码，邮箱选填，不显示来源。'
                      : config.UserConfig.RequireApproval
                        ? '未填邀请码时邮箱、来源必填；填写有效邀请码后邮箱选填，无需来源和审核。'
                        : '注册页保留账号、密码和选填邮箱，提交后直接登录。'}
                </p>
                <p className='mt-2'>
                  开关仅影响新注册。已有待审核账号仍需处理，可继续在此审核。
                </p>
              </div>
            </div>
          </AdminSection>
          <AdminSection
            title='默认用户组'
            description='新注册用户自动加入所选用户组；未选择时可访问全部采集源。'
          >
            {config.UserConfig.Tags && config.UserConfig.Tags.length > 0 ? (
              <div className='grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2'>
                {config.UserConfig.Tags.map((tag) => (
                  <label
                    key={tag.name}
                    className='flex min-w-0 flex-wrap items-center gap-y-1 rounded-md border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 cursor-pointer'
                  >
                    <input
                      type='checkbox'
                      checked={
                        config.SiteConfig.DefaultUserTags?.includes(tag.name) ||
                        false
                      }
                      onChange={async (e) => {
                        const isChecked = e.target.checked;
                        const tagName = tag.name;

                        await withLoading('toggleDefaultTag', async () => {
                          try {
                            const currentTags =
                              config.SiteConfig.DefaultUserTags || [];
                            const newTags = isChecked
                              ? [...currentTags, tagName]
                              : currentTags.filter((t) => t !== tagName);

                            const response = await fetch('/api/admin/config', {
                              method: 'POST',
                              headers: {
                                'Content-Type': 'application/json',
                              },
                              body: JSON.stringify({
                                ...config,
                                SiteConfig: {
                                  ...config.SiteConfig,
                                  DefaultUserTags:
                                    newTags.length > 0 ? newTags : undefined,
                                },
                              }),
                            });

                            if (response.ok) {
                              await refreshConfig();
                              showAlert({
                                type: 'success',
                                title: '设置已更新',
                                message: isChecked
                                  ? `已添加默认分组：${tagName}`
                                  : `已移除默认分组：${tagName}`,
                                timer: 2000,
                              });
                            } else {
                              throw new Error('更新失败');
                            }
                          } catch (err) {
                            showAlert({
                              type: 'error',
                              title: '更新失败',
                              message:
                                err instanceof Error ? err.message : '未知错误',
                            });
                          }
                        });
                      }}
                      className='h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded'
                    />
                    <span className='ml-3 text-sm font-medium text-gray-900 dark:text-gray-100'>
                      {tag.name}
                    </span>
                    <span className='ml-2 text-xs text-gray-500 dark:text-gray-400'>
                      ({tag.enabledApis.length} 个源
                      {tag.showAdultContent !== undefined &&
                        (tag.showAdultContent
                          ? ', 包含成人内容'
                          : ', 过滤成人内容')}
                      )
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className='text-sm text-gray-500 dark:text-gray-400 italic'>
                暂无可用的用户组，请前往“用户组”视图创建。
              </div>
            )}

            {config.SiteConfig.DefaultUserTags &&
              config.SiteConfig.DefaultUserTags.length > 0 && (
                <div className='mt-3 border-t border-gray-200 pt-3 dark:border-gray-700'>
                  <div className='admin-muted'>
                    已选择 {config.SiteConfig.DefaultUserTags.length}{' '}
                    个默认分组，新用户将获得这些分组的权限并集
                  </div>
                </div>
              )}
          </AdminSection>
          {/* 自动清理非活跃用户设置 */}
          <AdminSection
            title='非活跃账户清理'
            description='按最后登录时间，管理长期未使用的账户。'
          >
            <div className='mb-4 flex flex-wrap items-start justify-between gap-4'>
              <div>
                <div className='font-medium text-gray-900 dark:text-gray-100'>
                  自动清理非活跃用户
                </div>
                <div className='text-sm text-gray-600 dark:text-gray-400'>
                  自动删除指定天数内未登录的非活跃用户账号
                </div>
              </div>
              <div className='flex shrink-0 items-center'>
                <button
                  type='button'
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 ${
                    config.UserConfig.AutoCleanupInactiveUsers
                      ? buttonStyles.toggleOn
                      : buttonStyles.toggleOff
                  }`}
                  role='switch'
                  aria-label='自动清理非活跃用户'
                  disabled={isLoading('toggleAutoCleanup')}
                  aria-checked={config.UserConfig.AutoCleanupInactiveUsers}
                  onClick={async () => {
                    await withLoading('toggleAutoCleanup', async () => {
                      try {
                        const response = await fetch('/api/admin/config', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            ...config,
                            UserConfig: {
                              ...config.UserConfig,
                              AutoCleanupInactiveUsers:
                                !config.UserConfig.AutoCleanupInactiveUsers,
                            },
                          }),
                        });

                        if (response.ok) {
                          await refreshConfig();
                          showAlert({
                            type: 'success',
                            title: '设置已更新',
                            message: config.UserConfig.AutoCleanupInactiveUsers
                              ? '已禁用自动清理'
                              : '已启用自动清理',
                            timer: 2000,
                          });
                        } else {
                          throw new Error('更新失败');
                        }
                      } catch (err) {
                        showAlert({
                          type: 'error',
                          title: '更新失败',
                          message:
                            err instanceof Error ? err.message : '未知错误',
                        });
                      }
                    });
                  }}
                >
                  <span
                    aria-hidden='true'
                    className={`pointer-events-none inline-block h-5 w-5 rounded-full ${buttonStyles.toggleThumb} shadow transform ring-0 transition duration-200 ease-in-out ${
                      config.UserConfig.AutoCleanupInactiveUsers
                        ? buttonStyles.toggleThumbOn
                        : buttonStyles.toggleThumbOff
                    }`}
                  />
                </button>
                <span className='ml-3 text-sm font-medium text-gray-900 dark:text-gray-100'>
                  {config.UserConfig.AutoCleanupInactiveUsers ? '开启' : '关闭'}
                </span>
              </div>
            </div>

            {/* 天数设置 */}
            <div className='flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-700'>
              <label
                htmlFor='admin-inactive-days'
                className='text-sm font-medium text-gray-700 dark:text-gray-300'
              >
                保留天数：
              </label>
              <input
                id='admin-inactive-days'
                type='number'
                min='1'
                max='365'
                defaultValue={config.UserConfig.InactiveUserDays || 7}
                onBlur={async (e) => {
                  const days = parseInt(e.target.value) || 7;
                  if (days === (config.UserConfig.InactiveUserDays || 7)) {
                    return; // 没有变化，不需要保存
                  }

                  await withLoading('updateInactiveDays', async () => {
                    try {
                      const response = await fetch('/api/admin/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          ...config,
                          UserConfig: {
                            ...config.UserConfig,
                            InactiveUserDays: days,
                          },
                        }),
                      });

                      if (response.ok) {
                        await refreshConfig();
                        showAlert({
                          type: 'success',
                          title: '设置已更新',
                          message: `保留天数已设置为${days}天`,
                          timer: 2000,
                        });
                      } else {
                        throw new Error('更新失败');
                      }
                    } catch (err) {
                      showAlert({
                        type: 'error',
                        title: '更新失败',
                        message:
                          err instanceof Error ? err.message : '未知错误',
                      });
                    }
                  });
                }}
                className='w-20 px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
              />
              <span className='text-sm text-gray-600 dark:text-gray-400'>
                天。超过此时间未登录的用户将被自动删除。
              </span>
            </div>
          </AdminSection>
        </div>
      )}

      {role === 'owner' && (
        <UserApprovalModal
          isOpen={showApprovalModal}
          onClose={() => setShowApprovalModal(false)}
          pendingUsers={pendingUsers}
          onApprove={handleApproveUser}
          onReject={handleRejectUser}
          onRefresh={refreshConfig}
        />
      )}

      {drawerUser && (
        <UserActionDrawer
          open={Boolean(drawerUserUid)}
          title={drawerTitles[drawerView]}
          onClose={closeUserDrawer}
          returnFocusRef={drawerTriggerRef}
          fallbackFocusRef={userSearchRef}
          closeDisabled={drawerBusy}
          state={drawerBusy ? 'loading' : 'idle'}
          statusMessage={drawerBusy ? '正在处理，请稍候…' : undefined}
          header={
            drawerView !== 'overview' ? (
              <div className='admin-user-editor-context'>
                <button
                  type='button'
                  className='admin-user-drawer-back'
                  aria-label='返回用户详情'
                  disabled={drawerBusy}
                  onClick={returnToUserDetails}
                >
                  <ArrowLeft size={16} aria-hidden='true' />
                  返回用户详情
                </button>
                <span>
                  {drawerUser.username} · ID {drawerUser.uid}
                </span>
              </div>
            ) : undefined
          }
          footer={
            drawerSubmitLabels[drawerView] ? (
              <div className='admin-user-editor-actions'>
                <button
                  type='button'
                  className={buttonStyles.secondary}
                  disabled={drawerBusy}
                  onClick={returnToUserDetails}
                >
                  取消
                </button>
                <button
                  type='submit'
                  form='admin-user-editor-form'
                  className={
                    drawerView === 'delete' || drawerView === 'reject'
                      ? buttonStyles.danger
                      : buttonStyles.primary
                  }
                  disabled={
                    drawerBusy ||
                    (drawerView === 'password' && !changePasswordUser.password)
                  }
                >
                  {drawerBusy ? '处理中…' : drawerSubmitLabels[drawerView]}
                </button>
              </div>
            ) : undefined
          }
        >
          <div ref={drawerContentRef} data-user-uid={drawerUser.uid}>
            {drawerView === 'overview' && (
              <UserDrawerOverview
                user={drawerUser}
                config={config}
                isSelf={isCurrentUser(drawerUser)}
                canManage={canManageDrawerUser}
                canEditCredentials={canEditDrawerCredentials}
                canModerate={canModerateDrawerUser}
                canChangeRole={role === 'owner' && canModerateDrawerUser}
                busy={drawerBusy}
                onEdit={openDrawerEditor}
                onToggleAdmin={() =>
                  runDrawerAction(() =>
                    drawerUser.role === 'admin'
                      ? handleRemoveAdmin(drawerUser.uid)
                      : handleSetAdmin(drawerUser.uid),
                  )
                }
                onToggleBan={() =>
                  runDrawerAction(() =>
                    drawerUser.banned
                      ? handleUnbanUser(drawerUser.uid)
                      : handleBanUser(drawerUser.uid),
                  )
                }
                onDelete={() => handleDeleteUser(drawerUser)}
                onApprove={() =>
                  drawerUser.uid &&
                  runDrawerAction(() => handleApproveUser(drawerUser.uid!))
                }
                onReject={() => {
                  setRejectionReason('');
                  setDrawerView('reject');
                }}
              />
            )}

            {drawerView === 'tvbox' && canManageDrawerUser && (
              <TVBoxTokenModal
                key={drawerUser.uid}
                embedded
                username={drawerUser.username}
                targetUid={drawerUser.uid}
                tvboxToken={drawerUser.tvboxToken}
                tvboxEnabledSources={drawerUser.tvboxEnabledSources}
                allSources={config.SourceConfig.filter(
                  (source) => !source.disabled,
                ).map((source) => ({
                  key: source.key,
                  name: source.name,
                }))}
                onBusyChange={setTVBoxBusy}
                onClose={returnToUserDetails}
                onUpdate={refreshConfig}
              />
            )}

            {drawerView !== 'overview' && drawerView !== 'tvbox' && (
              <form
                id='admin-user-editor-form'
                className='admin-user-editor'
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitDrawerEditor();
                }}
              >
                <fieldset disabled={drawerBusy} className='contents'>
                  {drawerView === 'rename' && (
                    <>
                      <p className='admin-user-note'>
                        当前用户名：<strong>{drawerUser.username}</strong>
                      </p>
                      <div className='admin-user-field'>
                        <label htmlFor='admin-rename-new-username'>
                          新用户名
                        </label>
                        <input
                          ref={renameInputRef}
                          id='admin-rename-new-username'
                          data-drawer-autofocus
                          type='text'
                          autoComplete='off'
                          maxLength={20}
                          value={newUsername}
                          aria-invalid={Boolean(renameError)}
                          aria-describedby={
                            renameError
                              ? 'admin-rename-user-hint admin-rename-user-error'
                              : 'admin-rename-user-hint'
                          }
                          onChange={(event) => {
                            setNewUsername(event.target.value);
                            setRenameError('');
                          }}
                        />
                        <p
                          id='admin-rename-user-hint'
                          className='admin-field-hint'
                        >
                          支持汉字、字母、数字和下划线，长度为 2–20 位。
                        </p>
                      </div>
                      <p className='admin-user-note'>
                        邮箱、收藏和播放记录会保留。该账号需要使用新用户名重新登录。
                      </p>
                      {renameError && (
                        <div
                          id='admin-rename-user-error'
                          className='admin-user-error'
                          role='alert'
                        >
                          {renameError}
                        </div>
                      )}
                    </>
                  )}

                  {drawerView === 'password' && (
                    <>
                      <div className='admin-user-field'>
                        <label htmlFor='admin-user-new-password'>新密码</label>
                        <input
                          id='admin-user-new-password'
                          data-drawer-autofocus
                          type='password'
                          autoComplete='new-password'
                          value={changePasswordUser.password}
                          onChange={(event) =>
                            setChangePasswordUser((previous) => ({
                              ...previous,
                              password: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <p className='admin-user-note'>
                        修改后，该账号需要使用新密码登录。
                      </p>
                    </>
                  )}

                  {drawerView === 'groups' && (
                    <>
                      <p className='admin-user-note'>
                        可以加入多个用户组。不选择用户组时，使用账号的个人配置和站点默认规则。
                      </p>
                      <div className='admin-user-editor-toolbar'>
                        <span>已选择 {selectedUserGroups.length} 个用户组</span>
                        <button
                          type='button'
                          className={buttonStyles.quickAction}
                          onClick={() => setSelectedUserGroups([])}
                          data-drawer-autofocus
                        >
                          清空选择
                        </button>
                      </div>
                      <div className='admin-user-choice-list'>
                        {userGroups.map((group) => (
                          <label key={group.name} className='admin-user-choice'>
                            <input
                              type='checkbox'
                              checked={selectedUserGroups.includes(group.name)}
                              onChange={(event) =>
                                setSelectedUserGroups((previous) =>
                                  event.target.checked
                                    ? [...previous, group.name]
                                    : previous.filter(
                                        (name) => name !== group.name,
                                      ),
                                )
                              }
                            />
                            <span className='admin-user-choice-summary'>
                              <strong>{group.name}</strong>
                              <small>
                                {group.enabledApis?.length
                                  ? group.enabledApis.length + ' 个采集源'
                                  : '全部可用源'}
                              </small>
                            </span>
                          </label>
                        ))}
                        {userGroups.length === 0 && (
                          <p className='admin-user-empty'>
                            暂无用户组，可先在“用户组”页签中添加。
                          </p>
                        )}
                      </div>
                    </>
                  )}

                  {drawerView === 'sources' && (
                    <>
                      <p className='admin-user-note'>
                        选择后，此用户仅可访问个人配置中的采集源；不单独选择时，继承用户组和站点设置。
                      </p>
                      <div className='admin-user-field'>
                        <label htmlFor='admin-user-source-search'>
                          搜索采集源
                        </label>
                        <input
                          id='admin-user-source-search'
                          data-drawer-autofocus
                          type='search'
                          placeholder='按名称或标识查找'
                          value={sourceSearch}
                          onChange={(event) =>
                            setSourceSearch(event.target.value)
                          }
                        />
                      </div>
                      <div className='admin-user-editor-toolbar'>
                        <span>
                          {selectedApis.length
                            ? '已选择 ' + selectedApis.length + ' 个源'
                            : '继承用户组和站点设置'}
                        </span>
                        <div className='flex flex-wrap gap-2'>
                          <button
                            type='button'
                            className={buttonStyles.quickAction}
                            onClick={() => setSelectedApis([])}
                          >
                            清空选择
                          </button>
                          <button
                            type='button'
                            className={buttonStyles.quickAction}
                            onClick={() =>
                              setSelectedApis(
                                config.SourceConfig.filter(
                                  (source) => !source.disabled,
                                ).map((source) => source.key),
                              )
                            }
                          >
                            全选
                          </button>
                        </div>
                      </div>
                      <div className='admin-user-choice-list'>
                        {config.SourceConfig.filter((source) =>
                          (source.name + ' ' + source.key)
                            .toLowerCase()
                            .includes(sourceSearch.trim().toLowerCase()),
                        ).map((source) => (
                          <label key={source.key} className='admin-user-choice'>
                            <input
                              type='checkbox'
                              checked={selectedApis.includes(source.key)}
                              disabled={
                                source.disabled &&
                                !selectedApis.includes(source.key)
                              }
                              onChange={(event) =>
                                setSelectedApis((previous) =>
                                  event.target.checked
                                    ? [...previous, source.key]
                                    : previous.filter(
                                        (key) => key !== source.key,
                                      ),
                                )
                              }
                            />
                            <span className='admin-user-choice-summary'>
                              <strong>
                                {source.name}
                                {source.disabled ? '（已停用）' : ''}
                              </strong>
                              <small>
                                {source.api
                                  ? extractDomain(source.api)
                                  : source.key}
                              </small>
                            </span>
                          </label>
                        ))}
                        {!config.SourceConfig.some((source) =>
                          (source.name + ' ' + source.key)
                            .toLowerCase()
                            .includes(sourceSearch.trim().toLowerCase()),
                        ) && (
                          <p className='admin-user-empty'>
                            {config.SourceConfig.length
                              ? '没有匹配的采集源'
                              : '暂无采集源'}
                          </p>
                        )}
                      </div>
                      <label className='admin-user-choice'>
                        <input
                          type='checkbox'
                          checked={selectedShowAdultContent === true}
                          onChange={(event) =>
                            setSelectedShowAdultContent(event.target.checked)
                          }
                        />
                        <span className='admin-user-choice-summary'>
                          <strong>显示成人内容</strong>
                          <small>
                            {selectedShowAdultContent === undefined
                              ? '当前未单独设置，沿用用户组和站点规则。'
                              : '该账号的单独设置优先于用户组和站点规则。'}
                          </small>
                        </span>
                      </label>
                    </>
                  )}

                  {drawerView === 'delete' && (
                    <div className='admin-user-danger-note'>
                      <strong>确定删除 {drawerUser.username}？</strong>
                      <p>
                        账号及其搜索历史、播放记录和收藏将被删除，删除后无法恢复。
                      </p>
                      <p>确认后有 5 秒时间撤销操作。</p>
                    </div>
                  )}

                  {drawerView === 'reject' && (
                    <>
                      <div className='admin-user-danger-note'>
                        <strong>确定拒绝 {drawerUser.username} 的申请？</strong>
                        <p>拒绝后将删除此待审核账号，用户需要重新注册。</p>
                      </div>
                      <div className='admin-user-field'>
                        <label htmlFor='admin-user-rejection-reason'>
                          拒绝原因（可选）
                        </label>
                        <textarea
                          id='admin-user-rejection-reason'
                          data-drawer-autofocus
                          rows={4}
                          maxLength={500}
                          value={rejectionReason}
                          onChange={(event) =>
                            setRejectionReason(event.target.value)
                          }
                          placeholder='填写原因，便于申请人了解审核结果'
                        />
                        <p className='admin-field-hint'>
                          如账号有邮箱，原因会随审核结果通知发送。
                        </p>
                      </div>
                    </>
                  )}
                </fieldset>
              </form>
            )}
          </div>
        </UserActionDrawer>
      )}

      {/* 添加用户组弹窗 */}
      {showAddUserGroupForm &&
        createPortal(
          <div
            className='admin-dialog-overlay fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4'
            onClick={() => {
              setShowAddUserGroupForm(false);
              setNewUserGroup({
                name: '',
                enabledApis: [],
                showAdultContent: false,
              });
            }}
          >
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='admin-add-group-dialog'
              className='admin-dialog bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] overflow-y-auto'
              onClick={(e) => e.stopPropagation()}
            >
              <div className='p-6'>
                <div className='flex items-start justify-between gap-3 mb-5'>
                  <h3
                    id='admin-add-group-dialog'
                    className='text-xl font-semibold text-gray-900 dark:text-gray-100'
                  >
                    添加新用户组
                  </h3>
                  <button
                    onClick={() => {
                      setShowAddUserGroupForm(false);
                      setNewUserGroup({
                        name: '',
                        enabledApis: [],
                        showAdultContent: false,
                      });
                    }}
                    aria-label='关闭弹窗'
                    className='shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
                  >
                    <svg
                      className='w-6 h-6'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth={2}
                        d='M6 18L18 6M6 6l12 12'
                      />
                    </svg>
                  </button>
                </div>

                <div className='space-y-6'>
                  {/* 用户组名称 */}
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      用户组名称
                    </label>
                    <input
                      type='text'
                      placeholder='请输入用户组名称'
                      aria-label='用户组名称'
                      value={newUserGroup.name}
                      onChange={(e) =>
                        setNewUserGroup((prev) => ({
                          ...prev,
                          name: e.target.value,
                        }))
                      }
                      className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                    />
                  </div>

                  {/* 可用视频源 */}
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-4'>
                      可用视频源
                    </label>
                    <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'>
                      {config?.SourceConfig?.map((source) => (
                        <label
                          key={source.key}
                          className='flex items-center space-x-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors'
                        >
                          <input
                            type='checkbox'
                            checked={newUserGroup.enabledApis.includes(
                              source.key,
                            )}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setNewUserGroup((prev) => ({
                                  ...prev,
                                  enabledApis: [
                                    ...prev.enabledApis,
                                    source.key,
                                  ],
                                }));
                              } else {
                                setNewUserGroup((prev) => ({
                                  ...prev,
                                  enabledApis: prev.enabledApis.filter(
                                    (api) => api !== source.key,
                                  ),
                                }));
                              }
                            }}
                            className='rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700'
                          />
                          <div className='flex-1 min-w-0'>
                            <div className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                              {source.name}
                            </div>
                            {source.api && (
                              <div className='text-xs text-gray-500 dark:text-gray-400 truncate'>
                                {extractDomain(source.api)}
                              </div>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>

                    {/* 快速操作按钮 */}
                    <div className='mt-4 flex space-x-2'>
                      <button
                        onClick={() =>
                          setNewUserGroup((prev) => ({
                            ...prev,
                            enabledApis: [],
                          }))
                        }
                        className={buttonStyles.quickAction}
                      >
                        全不选（无限制）
                      </button>
                      <button
                        onClick={() => {
                          const allApis =
                            config?.SourceConfig?.filter(
                              (source) => !source.disabled,
                            ).map((s) => s.key) || [];
                          setNewUserGroup((prev) => ({
                            ...prev,
                            enabledApis: allApis,
                          }));
                        }}
                        className={buttonStyles.quickAction}
                      >
                        全选
                      </button>
                    </div>
                  </div>

                  {/* 成人内容控制 */}
                  <div className='p-4 bg-linear-to-r from-red-50 to-pink-50 dark:from-red-900/20 dark:to-pink-900/20 rounded-lg border border-red-200 dark:border-red-800'>
                    <label className='flex items-center justify-between cursor-pointer'>
                      <div className='flex-1'>
                        <div className='flex items-center space-x-2'>
                          <span className='text-base font-medium text-gray-900 dark:text-gray-100'>
                            显示成人内容
                          </span>
                          <span className='text-lg'>🔞</span>
                        </div>
                        <p className='text-sm text-gray-600 dark:text-gray-400 mt-1'>
                          允许此用户组查看被标记为成人资源的视频源（需要同时启用站点级别的成人内容开关）
                        </p>
                      </div>
                      <div className='relative inline-block ml-4'>
                        <input
                          type='checkbox'
                          checked={newUserGroup.showAdultContent}
                          onChange={(e) =>
                            setNewUserGroup((prev) => ({
                              ...prev,
                              showAdultContent: e.target.checked,
                            }))
                          }
                          className='sr-only peer'
                        />
                        <div className='w-14 h-7 bg-gray-300 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-300 dark:peer-focus:ring-red-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[""] after:absolute after:top-0.5 after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-linear-to-r peer-checked:from-red-600 peer-checked:to-pink-600'></div>
                      </div>
                    </label>
                  </div>

                  {/* 操作按钮 */}
                  <div className='flex justify-end space-x-3 pt-4 border-t border-gray-200 dark:border-gray-700'>
                    <button
                      onClick={() => {
                        setShowAddUserGroupForm(false);
                        setNewUserGroup({
                          name: '',
                          enabledApis: [],
                          showAdultContent: false,
                        });
                      }}
                      className={`px-6 py-2.5 text-sm font-medium ${buttonStyles.secondary}`}
                    >
                      取消
                    </button>
                    <button
                      onClick={handleAddUserGroup}
                      disabled={
                        !newUserGroup.name.trim() ||
                        isLoading('userGroup_add_new')
                      }
                      className={`px-6 py-2.5 text-sm font-medium ${!newUserGroup.name.trim() || isLoading('userGroup_add_new') ? buttonStyles.disabled : buttonStyles.primary}`}
                    >
                      {isLoading('userGroup_add_new')
                        ? '添加中...'
                        : '添加用户组'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 编辑用户组弹窗 */}
      {showEditUserGroupForm &&
        editingUserGroup &&
        createPortal(
          <div
            className='admin-dialog-overlay fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4'
            onClick={() => {
              setShowEditUserGroupForm(false);
              setEditingUserGroup(null);
            }}
          >
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='admin-edit-group-dialog'
              className='admin-dialog bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] overflow-y-auto'
              onClick={(e) => e.stopPropagation()}
            >
              <div className='p-6'>
                <div className='flex items-start justify-between gap-3 mb-5'>
                  <h3
                    id='admin-edit-group-dialog'
                    className='text-xl font-semibold text-gray-900 dark:text-gray-100'
                  >
                    编辑用户组 - {editingUserGroup.name}
                  </h3>
                  <button
                    onClick={() => {
                      setShowEditUserGroupForm(false);
                      setEditingUserGroup(null);
                    }}
                    aria-label='关闭弹窗'
                    className='shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
                  >
                    <svg
                      className='w-6 h-6'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth={2}
                        d='M6 18L18 6M6 6l12 12'
                      />
                    </svg>
                  </button>
                </div>

                <div className='space-y-6'>
                  {/* 可用视频源 */}
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-4'>
                      可用视频源
                    </label>
                    <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'>
                      {config?.SourceConfig?.map((source) => (
                        <label
                          key={source.key}
                          className='flex items-center space-x-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors'
                        >
                          <input
                            type='checkbox'
                            checked={editingUserGroup.enabledApis.includes(
                              source.key,
                            )}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setEditingUserGroup((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        enabledApis: [
                                          ...prev.enabledApis,
                                          source.key,
                                        ],
                                      }
                                    : null,
                                );
                              } else {
                                setEditingUserGroup((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        enabledApis: prev.enabledApis.filter(
                                          (api) => api !== source.key,
                                        ),
                                      }
                                    : null,
                                );
                              }
                            }}
                            className='rounded border-gray-300 text-purple-600 focus:ring-purple-500 dark:border-gray-600 dark:bg-gray-700'
                          />
                          <div className='flex-1 min-w-0'>
                            <div className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                              {source.name}
                            </div>
                            {source.api && (
                              <div className='text-xs text-gray-500 dark:text-gray-400 truncate'>
                                {extractDomain(source.api)}
                              </div>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>

                    {/* 快速操作按钮 */}
                    <div className='mt-4 flex space-x-2'>
                      <button
                        onClick={() =>
                          setEditingUserGroup((prev) =>
                            prev ? { ...prev, enabledApis: [] } : null,
                          )
                        }
                        className={buttonStyles.quickAction}
                      >
                        全不选（无限制）
                      </button>
                      <button
                        onClick={() => {
                          const allApis =
                            config?.SourceConfig?.filter(
                              (source) => !source.disabled,
                            ).map((s) => s.key) || [];
                          setEditingUserGroup((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  enabledApis: allApis,
                                }
                              : null,
                          );
                        }}
                        className={buttonStyles.quickAction}
                      >
                        全选
                      </button>
                    </div>
                  </div>

                  {/* 成人内容控制 */}
                  <div className='p-4 bg-linear-to-r from-red-50 to-pink-50 dark:from-red-900/20 dark:to-pink-900/20 rounded-lg border border-red-200 dark:border-red-800'>
                    <label className='flex items-center justify-between cursor-pointer'>
                      <div className='flex-1'>
                        <div className='flex items-center space-x-2'>
                          <span className='text-base font-medium text-gray-900 dark:text-gray-100'>
                            显示成人内容
                          </span>
                          <span className='text-lg'>🔞</span>
                        </div>
                        <p className='text-sm text-gray-600 dark:text-gray-400 mt-1'>
                          允许此用户组查看被标记为成人资源的视频源（需要同时启用站点级别的成人内容开关）
                        </p>
                      </div>
                      <div className='relative inline-block ml-4'>
                        <input
                          type='checkbox'
                          checked={editingUserGroup?.showAdultContent || false}
                          onChange={(e) =>
                            setEditingUserGroup((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    showAdultContent: e.target.checked,
                                  }
                                : null,
                            )
                          }
                          className='sr-only peer'
                        />
                        <div className='w-14 h-7 bg-gray-300 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-300 dark:peer-focus:ring-red-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[""] after:absolute after:top-0.5 after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-linear-to-r peer-checked:from-red-600 peer-checked:to-pink-600'></div>
                      </div>
                    </label>
                  </div>

                  {/* 操作按钮 */}
                  <div className='flex justify-end space-x-3 pt-4 border-t border-gray-200 dark:border-gray-700'>
                    <button
                      onClick={() => {
                        setShowEditUserGroupForm(false);
                        setEditingUserGroup(null);
                      }}
                      className={`px-6 py-2.5 text-sm font-medium ${buttonStyles.secondary}`}
                    >
                      取消
                    </button>
                    <button
                      onClick={handleEditUserGroup}
                      disabled={isLoading(
                        `userGroup_edit_${editingUserGroup?.name}`,
                      )}
                      className={`px-6 py-2.5 text-sm font-medium ${isLoading(`userGroup_edit_${editingUserGroup?.name}`) ? buttonStyles.disabled : buttonStyles.primary}`}
                    >
                      {isLoading(`userGroup_edit_${editingUserGroup?.name}`)
                        ? '保存中...'
                        : '保存修改'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 删除用户组确认弹窗 */}
      {showDeleteUserGroupModal &&
        deletingUserGroup &&
        createPortal(
          <div
            className='admin-dialog-overlay fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4'
            onClick={() => {
              setShowDeleteUserGroupModal(false);
              setDeletingUserGroup(null);
            }}
          >
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='admin-delete-group-dialog'
              className='admin-dialog bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto'
              onClick={(e) => e.stopPropagation()}
            >
              <div className='p-6'>
                <div className='flex items-start justify-between gap-3 mb-5'>
                  <h3
                    id='admin-delete-group-dialog'
                    className='text-xl font-semibold text-gray-900 dark:text-gray-100'
                  >
                    确认删除用户组
                  </h3>
                  <button
                    onClick={() => {
                      setShowDeleteUserGroupModal(false);
                      setDeletingUserGroup(null);
                    }}
                    aria-label='关闭弹窗'
                    className='shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
                  >
                    <svg
                      className='w-6 h-6'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth={2}
                        d='M6 18L18 6M6 6l12 12'
                      />
                    </svg>
                  </button>
                </div>

                <div className='mb-6'>
                  <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-4'>
                    <div className='flex items-center space-x-2 mb-2'>
                      <svg
                        className='w-5 h-5 text-red-600 dark:text-red-400'
                        fill='none'
                        stroke='currentColor'
                        viewBox='0 0 24 24'
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          strokeWidth={2}
                          d='M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z'
                        />
                      </svg>
                      <span className='text-sm font-medium text-red-800 dark:text-red-300'>
                        危险操作警告
                      </span>
                    </div>
                    <p className='text-sm text-red-700 dark:text-red-400'>
                      删除用户组 <strong>{deletingUserGroup.name}</strong>{' '}
                      将影响所有使用该组的用户，此操作不可恢复！
                    </p>
                  </div>

                  {deletingUserGroup.affectedUsers.length > 0 ? (
                    <div className='bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4'>
                      <div className='flex items-center space-x-2 mb-2'>
                        <svg
                          className='w-5 h-5 text-yellow-600 dark:text-yellow-400'
                          fill='none'
                          stroke='currentColor'
                          viewBox='0 0 24 24'
                        >
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            strokeWidth={2}
                            d='M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
                          />
                        </svg>
                        <span className='text-sm font-medium text-yellow-800 dark:text-yellow-300'>
                          ⚠️ 将影响 {deletingUserGroup.affectedUsers.length}{' '}
                          个用户：
                        </span>
                      </div>
                      <div className='space-y-1'>
                        {deletingUserGroup.affectedUsers.map((user, index) => (
                          <div
                            key={index}
                            className='text-sm text-yellow-700 dark:text-yellow-300'
                          >
                            • {user.username} ({user.role})
                          </div>
                        ))}
                      </div>
                      <p className='text-xs text-yellow-600 dark:text-yellow-400 mt-2'>
                        这些用户的用户组将被自动移除
                      </p>
                    </div>
                  ) : (
                    <div className='bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4'>
                      <div className='flex items-center space-x-2'>
                        <svg
                          className='w-5 h-5 text-green-600 dark:text-green-400'
                          fill='none'
                          stroke='currentColor'
                          viewBox='0 0 24 24'
                        >
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            strokeWidth={2}
                            d='M5 13l4 4L19 7'
                          />
                        </svg>
                        <span className='text-sm font-medium text-green-800 dark:text-green-300'>
                          当前没有用户使用此用户组
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* 操作按钮 */}
                <div className='flex flex-wrap justify-end gap-3'>
                  <button
                    onClick={() => {
                      setShowDeleteUserGroupModal(false);
                      setDeletingUserGroup(null);
                    }}
                    className={`px-6 py-2.5 text-sm font-medium ${buttonStyles.secondary}`}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleConfirmDeleteUserGroup}
                    disabled={isLoading(
                      `userGroup_delete_${deletingUserGroup?.name}`,
                    )}
                    className={`px-6 py-2.5 text-sm font-medium ${isLoading(`userGroup_delete_${deletingUserGroup?.name}`) ? buttonStyles.disabled : buttonStyles.danger}`}
                  >
                    {isLoading(`userGroup_delete_${deletingUserGroup?.name}`)
                      ? '删除中...'
                      : '确认删除'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 批量设置用户组弹窗 */}
      {showBatchUserGroupModal &&
        createPortal(
          <div
            className='admin-dialog-overlay fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4'
            onClick={() => {
              setShowBatchUserGroupModal(false);
              setSelectedUserGroup('');
            }}
          >
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='admin-batch-group-dialog'
              className='admin-dialog bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto'
              onClick={(e) => e.stopPropagation()}
            >
              <div className='p-6'>
                <div className='flex items-start justify-between gap-3 mb-5'>
                  <h3
                    id='admin-batch-group-dialog'
                    className='text-xl font-semibold text-gray-900 dark:text-gray-100'
                  >
                    批量设置用户组
                  </h3>
                  <button
                    onClick={() => {
                      setShowBatchUserGroupModal(false);
                      setSelectedUserGroup('');
                    }}
                    aria-label='关闭弹窗'
                    className='shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
                  >
                    <svg
                      className='w-6 h-6'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth={2}
                        d='M6 18L18 6M6 6l12 12'
                      />
                    </svg>
                  </button>
                </div>

                <div className='mb-6'>
                  <div className='bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4'>
                    <div className='flex items-center space-x-2 mb-2'>
                      <svg
                        className='w-5 h-5 text-blue-600 dark:text-blue-400'
                        fill='none'
                        stroke='currentColor'
                        viewBox='0 0 24 24'
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          strokeWidth={2}
                          d='M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
                        />
                      </svg>
                      <span className='text-sm font-medium text-blue-800 dark:text-blue-300'>
                        批量操作说明
                      </span>
                    </div>
                    <p className='text-sm text-blue-700 dark:text-blue-400'>
                      将为选中的 <strong>{selectedUsers.size} 个用户</strong>{' '}
                      设置用户组，选择"无用户组"为无限制
                    </p>
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      选择用户组：
                    </label>
                    <select
                      onChange={(e) => setSelectedUserGroup(e.target.value)}
                      className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors'
                      value={selectedUserGroup}
                    >
                      <option value=''>无用户组（无限制）</option>
                      {userGroups.map((group) => (
                        <option key={group.name} value={group.name}>
                          {group.name}{' '}
                          {group.enabledApis && group.enabledApis.length > 0
                            ? `(${group.enabledApis.length} 个源)`
                            : ''}
                        </option>
                      ))}
                    </select>
                    <p className='mt-2 text-xs text-gray-500 dark:text-gray-400'>
                      选择"无用户组"为无限制，选择特定用户组将限制用户只能访问该用户组允许的采集源
                    </p>
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className='flex flex-wrap justify-end gap-3'>
                  <button
                    onClick={() => {
                      setShowBatchUserGroupModal(false);
                      setSelectedUserGroup('');
                    }}
                    className={`px-6 py-2.5 text-sm font-medium ${buttonStyles.secondary}`}
                  >
                    取消
                  </button>
                  <button
                    onClick={() => handleBatchSetUserGroup(selectedUserGroup)}
                    disabled={isLoading('batchSetUserGroup')}
                    className={`px-6 py-2.5 text-sm font-medium ${isLoading('batchSetUserGroup') ? buttonStyles.disabled : buttonStyles.primary}`}
                  >
                    {isLoading('batchSetUserGroup') ? '设置中...' : '确认设置'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 通用弹窗组件 */}
      <AlertModal
        isOpen={alertModal.isOpen}
        onClose={hideAlert}
        type={alertModal.type}
        title={alertModal.title}
        message={alertModal.message}
        timer={alertModal.timer}
        showConfirm={alertModal.showConfirm}
        showUndo={alertModal.showUndo}
        onUndo={alertModal.onUndo}
        undoTimer={alertModal.undoTimer}
      />
    </div>
  );
};

export default UserConfig;
