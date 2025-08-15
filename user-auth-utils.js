// ユーザー認証ユーティリティ
class UserAuthUtils {
    constructor() {
        this.supabaseClient = null;
        this.initializeSupabase();
    }

    // Supabase初期化
    initializeSupabase() {
        if (typeof createSupabaseClient === 'function') {
            this.supabaseClient = createSupabaseClient();
        } else {
            console.error('Supabase設定が見つかりません');
        }
    }

    // パスワードハッシュ生成（bcrypt互換）
    async generatePasswordHash(password, saltRounds = 10) {
        try {
            // bcryptライブラリが利用可能な場合は使用
            if (typeof bcrypt !== 'undefined') {
                return await bcrypt.hash(password, saltRounds);
            }
            
            // 簡易版ハッシュ生成（実際の運用ではbcryptを使用）
            return this.simpleHash(password);
        } catch (error) {
            console.error('ハッシュ生成エラー:', error);
            return this.simpleHash(password);
        }
    }

    // 簡易ハッシュ生成（テスト用）
    simpleHash(password) {
        // 実際の運用ではbcrypt等の専用ライブラリを使用
        return CryptoJS.SHA256(password + 'salt').toString();
    }

    // パスワード検証
    async verifyPassword(password, hash) {
        try {
            // bcryptライブラリが利用可能な場合は使用
            if (typeof bcrypt !== 'undefined') {
                return await bcrypt.compare(password, hash);
            }
            
            // 簡易版検証（実際の運用ではbcryptを使用）
            return this.simpleVerify(password, hash);
        } catch (error) {
            console.error('パスワード検証エラー:', error);
            return this.simpleVerify(password, hash);
        }
    }

    // 簡易パスワード検証（テスト用）
    simpleVerify(password, hash) {
        const expectedHash = this.simpleHash(password);
        return hash === expectedHash;
    }

    // ユーザーログイン
    async login(username, password) {
        if (!this.supabaseClient) {
            throw new Error('Supabaseクライアントが初期化されていません');
        }

        try {
            // ユーザー検索
            const { data, error } = await this.supabaseClient
                .from('users')
                .select('*')
                .eq('username', username)
                .eq('is_active', true)
                .single();

            if (error || !data) {
                throw new Error('ユーザーが見つかりません');
            }

            // パスワード検証
            const isValidPassword = await this.verifyPassword(password, data.password_hash);
            
            if (!isValidPassword) {
                throw new Error('パスワードが正しくありません');
            }

            // 最終ログイン時刻を更新
            await this.updateLastLogin(data.id);

            return {
                success: true,
                user: data
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // 最終ログイン時刻更新
    async updateLastLogin(userId) {
        try {
            // IDの型をチェックして適切なクエリを構築
            let processedUserId = userId;
            
            // UUID形式のIDが渡された場合の処理
            if (typeof userId === 'string' && userId.includes('-')) {
                // UUID形式の場合は、auth_idで更新
                await this.supabaseClient
                    .from('users')
                    .update({ last_login: new Date().toISOString() })
                    .eq('auth_id', userId);
                return;
            }
            
            // 文字列の場合は数値に変換
            if (typeof userId === 'string') {
                processedUserId = parseInt(userId, 10);
                if (isNaN(processedUserId)) {
                    console.error('ユーザーIDの形式が正しくありません。数値IDを使用してください:', userId);
                    return;
                }
            }

            await this.supabaseClient
                .from('users')
                .update({ last_login: new Date().toISOString() })
                .eq('id', processedUserId);
        } catch (error) {
            console.error('最終ログイン時刻更新エラー:', error);
        }
    }

    // ユーザー登録（無効化）
    async registerUser(userData) {
        // 新規登録機能は無効化されています
        // ユーザーの追加は管理者が直接データベースで行います
        return {
            success: false,
            error: '新規登録機能は無効化されています。管理者にお問い合わせください。'
        };
    }

    // ユーザー情報取得
    async getUserById(userId) {
        if (!this.supabaseClient) {
            throw new Error('Supabaseクライアントが初期化されていません');
        }

        try {
            console.log('getUserById: userId =', userId, 'type =', typeof userId);
            
            // IDの型をチェックして適切なクエリを構築
            let processedUserId = userId;
            
            // UUID形式のIDが渡された場合の処理
            if (typeof userId === 'string' && userId.includes('-')) {
                console.log('getUserById: UUID形式のIDを検出、auth_idで検索します');
                // UUID形式の場合は、auth_idで検索
                const { data, error } = await this.supabaseClient
                    .from('users')
                    .select('*')
                    .eq('auth_id', userId)
                    .single();

                if (error) {
                    console.error('getUserById error (auth_id):', error);
                    console.error('Error details:', {
                        code: error.code,
                        message: error.message,
                        details: error.details,
                        hint: error.hint
                    });
                    
                    // 406 Not Acceptableエラーの場合
                    if (error.code === '406' || error.message.includes('Not Acceptable')) {
                        throw new Error(`auth_idカラムが存在しないか、アクセス権限がありません: ${userId}`);
                    }
                    
                    throw new Error('ユーザーが見つかりません');
                }

                if (!data) {
                    console.log('getUserById: ユーザーが見つかりません (auth_id)');
                    throw new Error('ユーザーが見つかりません');
                }

                console.log('getUserById: ユーザー取得成功 (auth_id):', data);
                return {
                    success: true,
                    user: data
                };
            }
            
            // 文字列の場合は数値に変換
            if (typeof userId === 'string') {
                processedUserId = parseInt(userId, 10);
                if (isNaN(processedUserId)) {
                    throw new Error(`ユーザーIDの形式が正しくありません: ${userId}`);
                }
            }

            console.log('getUserById: 整数IDで検索します:', processedUserId);
            const { data, error } = await this.supabaseClient
                .from('users')
                .select('*')
                .eq('id', processedUserId)
                .single();

            if (error) {
                // エラーの詳細をログに出力
                console.error('getUserById error:', error);
                console.error('Error details:', {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                    hint: error.hint
                });
                
                // 400 Bad Requestエラーの場合は、IDの型が間違っている可能性
                if (error.code === '400' || error.message.includes('Bad Request')) {
                    throw new Error(`ユーザーIDの形式が正しくありません: ${userId}`);
                }
                
                throw new Error('ユーザーが見つかりません');
            }

            if (!data) {
                console.log('getUserById: ユーザーが見つかりません (id)');
                throw new Error('ユーザーが見つかりません');
            }

            console.log('getUserById: ユーザー取得成功 (id):', data);
            return {
                success: true,
                user: data
            };

        } catch (error) {
            console.error('getUserById catch error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // auth_idでユーザー情報取得
    async getUserByAuthId(authId) {
        if (!this.supabaseClient) {
            throw new Error('Supabaseクライアントが初期化されていません');
        }

        try {
            console.log('getUserByAuthId: authId =', authId);
            
            const { data, error } = await this.supabaseClient
                .from('users')
                .select('*')
                .eq('auth_id', authId)
                .single();

            if (error) {
                console.error('getUserByAuthId error:', error);
                console.error('Error details:', {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                    hint: error.hint
                });
                
                // 406 Not Acceptableエラーの場合
                if (error.code === '406' || error.message.includes('Not Acceptable')) {
                    throw new Error(`auth_idカラムが存在しないか、アクセス権限がありません: ${authId}`);
                }
                
                // その他のエラー
                throw new Error(`ユーザー取得エラー: ${error.message}`);
            }

            if (!data) {
                console.log('getUserByAuthId: ユーザーが見つかりません');
                throw new Error('ユーザーが見つかりません');
            }

            console.log('getUserByAuthId: ユーザー取得成功:', data);
            return {
                success: true,
                user: data
            };

        } catch (error) {
            console.error('getUserByAuthId catch error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // ユーザー情報更新
    async updateUser(userId, updateData) {
        if (!this.supabaseClient) {
            throw new Error('Supabaseクライアントが初期化されていません');
        }

        try {
            // IDの型をチェックして適切なクエリを構築
            let processedUserId = userId;
            
            // UUID形式のIDが渡された場合の処理
            if (typeof userId === 'string' && userId.includes('-')) {
                // UUID形式の場合は、auth_idで更新
                const { data, error } = await this.supabaseClient
                    .from('users')
                    .update(updateData)
                    .eq('auth_id', userId)
                    .select();

                if (error) {
                    throw new Error('ユーザー情報の更新に失敗しました: ' + error.message);
                }

                return {
                    success: true,
                    user: data[0]
                };
            }
            
            // 文字列の場合は数値に変換
            if (typeof userId === 'string') {
                processedUserId = parseInt(userId, 10);
                if (isNaN(processedUserId)) {
                    throw new Error(`ユーザーIDの形式が正しくありません: ${userId}`);
                }
            }

            const { data, error } = await this.supabaseClient
                .from('users')
                .update(updateData)
                .eq('id', processedUserId)
                .select();

            if (error) {
                throw new Error('ユーザー情報の更新に失敗しました: ' + error.message);
            }

            return {
                success: true,
                user: data[0]
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // パスワード変更
    async changePassword(userId, currentPassword, newPassword) {
        try {
            // 現在のユーザー情報を取得
            const userResult = await this.getUserById(userId);
            if (!userResult.success) {
                throw new Error(userResult.error);
            }

            // 現在のパスワードを検証
            const isValidCurrentPassword = await this.verifyPassword(currentPassword, userResult.user.password_hash);
            if (!isValidCurrentPassword) {
                throw new Error('現在のパスワードが正しくありません');
            }

            // 新しいパスワードハッシュを生成
            const newPasswordHash = await this.generatePasswordHash(newPassword);

            // パスワードを更新
            const updateResult = await this.updateUser(userId, {
                password_hash: newPasswordHash
            });

            return updateResult;

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // ユーザー一覧取得
    async getAllUsers() {
        if (!this.supabaseClient) {
            throw new Error('Supabaseクライアントが初期化されていません');
        }

        try {
            const { data, error } = await this.supabaseClient
                .from('users')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) {
                throw new Error('ユーザー一覧の取得に失敗しました: ' + error.message);
            }

            return {
                success: true,
                users: data
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // ユーザー削除（論理削除）
    async deactivateUser(userId) {
        return await this.updateUser(userId, { is_active: false });
    }

    // ユーザー有効化
    async activateUser(userId) {
        return await this.updateUser(userId, { is_active: true });
    }

    // セッション管理
    saveSession(userData) {
        // UUID形式のIDが含まれている場合は警告
        if (userData && userData.id && typeof userData.id === 'string' && userData.id.includes('-')) {
            console.warn('UUID形式のIDが検出されました。セッションをクリアして再ログインしてください。');
            this.clearSession();
            return false;
        }
        
        localStorage.setItem('currentUser', JSON.stringify(userData));
        localStorage.setItem('loginTime', new Date().toISOString());
        return true;
    }

    getSession() {
        const userData = localStorage.getItem('currentUser');
        const loginTime = localStorage.getItem('loginTime');
        
        if (!userData) {
            return null;
        }
        
        try {
            const user = JSON.parse(userData);
            
            // UUID形式のIDが含まれている場合はセッションをクリア
            if (user && user.id && typeof user.id === 'string' && user.id.includes('-')) {
                console.warn('UUID形式のIDが検出されました。セッションをクリアします。');
                this.clearSession();
                return null;
            }
            
            // ログイン時間のチェック（24時間）
            if (loginTime) {
                const loginDate = new Date(loginTime);
                const now = new Date();
                const hoursDiff = (now - loginDate) / (1000 * 60 * 60);
                
                if (hoursDiff > 24) {
                    console.log('セッションが24時間を超えました。ログアウトします。');
                    this.clearSession();
                    return null;
                }
            }
            
            return user;
        } catch (error) {
            console.error('セッション情報の解析に失敗:', error);
            this.clearSession();
            return null;
        }
    }

    clearSession() {
        localStorage.removeItem('currentUser');
        localStorage.removeItem('loginTime');
        console.log('セッションをクリアしました');
    }

    // 強制セッションクリア（UUID形式のID対策）
    forceClearSession() {
        this.clearSession();
        console.log('強制セッションクリアを実行しました。再ログインしてください。');
        return true;
    }

    // デバッグ用：現在のセッション情報を表示
    debugSession() {
        const userData = localStorage.getItem('currentUser');
        const loginTime = localStorage.getItem('loginTime');
        
        console.log('=== セッション情報 ===');
        console.log('currentUser:', userData);
        console.log('loginTime:', loginTime);
        
        if (userData) {
            try {
                const user = JSON.parse(userData);
                console.log('パースされたユーザー情報:', user);
                
                if (user && user.id) {
                    console.log('ユーザーID:', user.id, '型:', typeof user.id);
                    if (typeof user.id === 'string' && user.id.includes('-')) {
                        console.warn('⚠️ UUID形式のIDが検出されました！');
                    }
                }
            } catch (error) {
                console.error('セッション情報の解析エラー:', error);
            }
        }
        
        return {
            userData,
            loginTime,
            hasUserData: !!userData
        };
    }

    // デバッグ用：セッションを完全にクリア
    debugClearAllSessions() {
        console.log('=== セッション完全クリア開始 ===');
        
        // すべてのローカルストレージをクリア
        localStorage.clear();
        sessionStorage.clear();
        
        console.log('ローカルストレージとセッションストレージをクリアしました');
        console.log('ページをリロードしてください');
        
        return true;
    }

    // 権限チェック
    hasPermission(user, requiredRole) {
        const roleHierarchy = {
            'staff': 1,
            'developer': 2,
            'administrator': 3
        };

        const userLevel = roleHierarchy[user.role] || 0;
        const requiredLevel = roleHierarchy[requiredRole] || 0;

        return userLevel >= requiredLevel;
    }

    // 権限表示名取得
    getRoleDisplayName(role) {
        const roleNames = {
            'administrator': '管理者',
            'developer': '開発者',
            'staff': 'スタッフ'
        };
        return roleNames[role] || role;
    }
}

// グローバルインスタンス作成
window.userAuthUtils = new UserAuthUtils();
